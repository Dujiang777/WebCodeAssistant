#!/usr/bin/env node
/**
 * 端到端自测脚本（不依赖浏览器）。
 *
 * 它按 README 里的演示步骤逐步调用真实 HTTP 接口，并在最后校验
 * 「补丁应用之后，磁盘上的文件真的变了」—— 这是整个产品最核心的一条链路，
 * 也是唯一无法靠单元测试覆盖（它跨了 DB + SSE + 文件系统）的部分。
 *
 * 用法：
 *   node tools/e2e-smoke.mjs
 *   BASE_URL=http://127.0.0.1:8080 node tools/e2e-smoke.mjs
 *   REPORT_FILE=report.txt node tools/e2e-smoke.mjs   # 额外落一份无颜色标记的纯文本报告
 *
 * 退出码：0 = 全部通过，1 = 有失败项。
 */

import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const TARGET_FILE = 'src/main/java/com/demo/UserService.java';
const TRAVERSAL_ATTEMPT = '../../../../Windows/win.ini';
const REPORT_FILE = process.env.REPORT_FILE ?? null;

let pass = 0;
let fail = 0;
const report = [];

function emit(line) {
  console.log(line);
  report.push(line.replace(/\u001b\[[0-9;]*m/g, ''));
}

function ok(name, detail) {
  pass += 1;
  emit(`  \u001b[32m✓\u001b[0m ${name}${detail ? ` \u001b[90m— ${detail}\u001b[0m` : ''}`);
}

function bad(name, detail) {
  fail += 1;
  emit(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` \u001b[90m— ${detail}\u001b[0m` : ''}`);
}

function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, detail);
}

function note(text) {
  emit(`    ${text}`);
}

function section(title) {
  emit(`\n\u001b[1m${title}\u001b[0m`);
}

// ------------------------------------------------------------------ HTTP

async function call(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return raw ? { status: response.status, text } : { status: response.status, data };
}

// ------------------------------------------------------------------- SSE

/**
 * 订阅事件流并回调。返回一个可关闭的句柄 + 已收到的事件数组。
 * 这里用最朴素的手工解析（而不是引 SDK）：客户端实现也就这十几行，
 * 而它能顺带验证「后端推的真的是标准 SSE 帧」。
 */
async function openStream(sessionId, token, onEvent) {
  const controller = new AbortController();
  const state = { events: [], closed: false };

  const response = await fetch(`${BASE}/api/chat/sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`事件流建立失败：HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5).trim());
              state.events.push(event);
              onEvent(event);
            } catch {
              // 忽略无法解析的帧（例如心跳注释外的噪声）
            }
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // 主动 abort / 连接结束，都走这里
    } finally {
      state.closed = true;
    }
  })();

  return {
    state,
    close: () => controller.abort(),
  };
}

function waitUntil(probe, timeoutMs, what) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = probe();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`等待「${what}」超时（${timeoutMs}ms）`));
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

// ------------------------------------------------------------------ 主流程

async function main() {
  emit(`\u001b[1mWeb Code Assistant 端到端自测\u001b[0m  目标：${BASE}`);

  section('1. 健康检查');
  const health = await call('/api/health');
  check('GET /api/health 可用', health.status === 200, `HTTP ${health.status}`);
  if (health.status === 200) {
    note(
      `模型：${health.data.modelConfigured ? health.data.model : '未配置'}｜检索：${health.data.grepEngine}｜Redis：${
        health.data.redisAvailable ? '可用' : '降级'
      }`,
    );
    if (!health.data.modelConfigured) {
      note('\u001b[33m后端未配置模型，对话链路会停在「模型未配置」。请先设置 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL。\u001b[0m');
    }
  } else {
    note('后端不可达，后续步骤无法继续。');
    return;
  }

  section('2. 注册 / 登录');
  const username = `smoke_${Math.random().toString(36).slice(2, 8)}`;
  const password = 'smoke1234';
  let auth = await call('/api/auth/register', { method: 'POST', body: { username, password } });
  check('注册新账号', auth.status === 201 || auth.status === 200, `HTTP ${auth.status}`);
  if (auth.status !== 201 && auth.status !== 200) {
    auth = await call('/api/auth/login', { method: 'POST', body: { username, password } });
    check('改用登录', auth.status === 200, `HTTP ${auth.status}`);
  }
  const token = auth.data?.token;
  check('拿到 JWT', typeof token === 'string' && token.length > 20);

  section('3. 创建内置示例工作区');
  const created = await call('/api/workspaces', {
    method: 'POST',
    token,
    body: { sample: true, name: `smoke-${Date.now().toString().slice(-5)}` },
  });
  check('创建工作区', created.status === 201, `HTTP ${created.status}`);
  const workspaceId = created.data?.id;
  if (!workspaceId) {
    note('未能创建工作区，终止。');
    return;
  }
  note(`工作区 #${workspaceId} · ${created.data.name}`);

  section('4. 读取文件树');
  const tree = await call(`/api/workspaces/${workspaceId}/tree`, { token });
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.type === 'dir') walk(node.children);
      else flat.push(node.path);
    }
  };
  walk(tree.data?.children);
  check('文件树可读', tree.status === 200 && flat.length > 0, `${flat.length} 个文件`);
  check('树里包含 UserService.java', flat.includes(TARGET_FILE));

  section('5. 读取目标文件（应用补丁前的基线）');
  const before = await call(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(TARGET_FILE)}`, { token });
  check('读取 UserService.java', before.status === 200 && typeof before.data.content === 'string');
  const beforeText = before.data?.content ?? '';
  check(
    '基线里存在字段注入',
    beforeText.includes('@Autowired') && beforeText.includes('private UserRepository userRepository'),
  );
  note(`文件 ${before.data?.sizeBytes} 字节 · 语言 ${before.data?.language}`);

  section('6. 路径越界防护');
  const escape = await call(
    `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(TRAVERSAL_ATTEMPT)}`,
    { token },
  );
  check('越界读取被拒绝', escape.status >= 400, `HTTP ${escape.status} ${escape.data?.code ?? ''}`);
  const escapeWrite = await call(
    `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent('../escaped.txt')}`,
    { method: 'PUT', token, body: { content: 'nope' } },
  );
  check('越界写入被拒绝', escapeWrite.status >= 400, `HTTP ${escapeWrite.status} ${escapeWrite.data?.code ?? ''}`);

  if (!health.data.modelConfigured) {
    note('\u001b[33m跳过 7–14：模型未配置，无法验证对话、引用、补丁与编译链路。\u001b[0m');
    summary();
    return;
  }

  section('7. 建立会话与事件流');
  const session = await call('/api/chat/sessions', { method: 'POST', token, body: { workspaceId } });
  check('创建会话', session.status === 201, `HTTP ${session.status}`);
  const sessionId = session.data?.id;

  // 事件统计放在回调里累加，绝不去动 state.events ——
  // 那个数组是给 waitUntil 轮询用的，消费掉它就会「事件明明收到了却断言失败」。
  const seenText = [];
  const toolCalls = [];
  const stream = await openStream(sessionId, token, (event) => {
    if (event.type === 'text') seenText.push(event.delta);
    if (event.type === 'tool_call') toolCalls.push(event.name);
  });
  ok('SSE 长连接已建立');

  section('8. 第一轮：问「解释这个类」（验证引用必须带行号）');
  const explainSent = await call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    token,
    body: { content: '解释一下这个类', currentFile: TARGET_FILE },
  });
  check('消息已受理（202）', explainSent.status === 202, `HTTP ${explainSent.status}`);

  note('等待模型输出…');
  const firstDone = await waitUntil(
    () => stream.state.events.find((event) => event.type === 'done') ?? null,
    90_000,
    '第一轮 done 事件',
  ).catch((error) => {
    bad('第一轮收到 done 事件', error.message);
    return null;
  });
  check('第一轮收到 done 事件', firstDone !== null);

  // citations 在 done 之前推送，所以这里直接查而不等
  const citationsEvent = stream.state.events.find((event) => event.type === 'citations') ?? null;
  check('收到 citations 事件', citationsEvent !== null, citationsEvent ? `${(citationsEvent.items ?? []).length} 条引用` : '未收到');
  const citeItems = Array.isArray(citationsEvent?.items) ? citationsEvent.items : [];
  check(
    '引用带上了行号（不是光秃秃的路径）',
    citeItems.some((item) => typeof item.line === 'number'),
    citeItems
      .map((item) => `${item.file}:${item.line ?? '-'}`)
      .join('  ')
      .slice(0, 220),
  );
  check(
    '引用全部通过校验（文件存在 / 行号不越界）',
    citeItems.length > 0 && citeItems.every((item) => item.valid !== false),
    `${citeItems.filter((item) => item.valid === false).length} 条存疑`,
  );

  const history = await call(`/api/chat/sessions/${sessionId}/messages`, { token });
  const assistantWithMeta = (history.data ?? []).find(
    (message) => message.role === 'assistant' && Array.isArray(message.meta?.citations),
  );
  check(
    '引用已落库到消息 meta',
    Boolean(assistantWithMeta),
    assistantWithMeta ? `meta 里 ${assistantWithMeta.meta.citations.length} 条 + mode=${assistantWithMeta.meta.mode}` : '未找到',
  );

  section('9. 第二轮：让 AI 重构 UserService（验证补丁）');
  const mark = stream.state.events.length;
  const sent = await call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    token,
    body: {
      content: '把这个类里的字段注入改成构造器注入，并移除不再需要的 Autowired 导入。',
      currentFile: TARGET_FILE,
    },
  });
  check('消息已受理（202）', sent.status === 202, `HTTP ${sent.status}`);
  check('返回用户消息 id', typeof sent.data?.messageId === 'number');

  const patchEvent = await waitUntil(
    () => stream.state.events.slice(mark).find((event) => event.type === 'patch') ?? null,
    90_000,
    'patch 事件',
  ).catch((error) => {
    bad('收到 patch 事件', error.message);
    return null;
  });

  check('收到 patch 事件', patchEvent !== null);
  if (patchEvent) {
    note(`补丁 ${patchEvent.id} · ${patchEvent.file}`);
  }

  const doneEvent = await waitUntil(
    () => stream.state.events.slice(mark).find((event) => event.type === 'done') ?? null,
    30_000,
    'done 事件',
  ).catch(() => null);
  check('收到 done 事件', doneEvent !== null, doneEvent ? `assistant 消息 #${doneEvent.messageId}` : '未收到');

  check('收到流式文本', seenText.length > 0, `${seenText.length} 个增量片段`);
  check('过程中出现了工具调用', toolCalls.length > 0, toolCalls.join(' → '));
  check(
    '先读文件再出补丁',
    toolCalls.includes('read_file') && toolCalls.includes('propose_patch'),
    toolCalls.join(' → '),
  );

  section('10. 影响面（应用之前就能看）');
  if (!patchEvent) {
    note('没有补丁可分析，跳过。');
  } else {
    const radius = await call(`/api/patches/${patchEvent.id}/blast-radius`, { token });
    check('GET blast-radius 可用', radius.status === 200, `HTTP ${radius.status}`);
    const r = radius.data ?? {};
    check('给出了风险等级', ['high', 'medium', 'low'].includes(r.riskLevel), String(r.riskLevel));
    check(
      '识别出被改动的成员',
      Array.isArray(r.changedMembers) && r.changedMembers.length > 0,
      (r.changedMembers ?? []).join(', ').slice(0, 140),
    );
    check(
      '列出了调用方或测试',
      (r.callers?.length ?? 0) + (r.tests?.length ?? 0) > 0,
      `${r.callers?.length ?? 0} 处调用 / ${r.tests?.length ?? 0} 个测试文件`,
    );
    note(`风险=${r.riskLevel}｜${r.headline ?? ''}`);

    const early = await call(`/api/patches/${patchEvent.id}/compile`, { method: 'POST', token });
    check(
      '未应用的补丁不给编译结论（disabled）',
      early.data?.status === 'disabled',
      `status=${early.data?.status}`,
    );
  }

  section('11. 应用补丁');
  if (!patchEvent) {
    note('没有补丁可应用，跳过。');
  } else {
    const applied = await call(`/api/patches/${patchEvent.id}/apply`, { method: 'POST', token });
    check('补丁应用成功', applied.status === 200, `HTTP ${applied.status} ${applied.data?.code ?? ''}`);
    check('补丁状态变为 applied', applied.data?.status === 'applied');

    const again = await call(`/api/patches/${patchEvent.id}/apply`, { method: 'POST', token });
    check('重复应用被拒绝', again.status >= 400, `HTTP ${again.status} ${again.data?.code ?? ''}`);
  }

  section('12. 编译验证（应用之后才跑）');
  if (!patchEvent) {
    note('没有补丁，跳过。');
  } else {
    const compiled = await call(`/api/patches/${patchEvent.id}/compile`, { method: 'POST', token });
    const status = compiled.data?.status;
    check('编译接口返回明确状态', ['ok', 'failed', 'timeout', 'unavailable'].includes(status), `status=${status}`);
    if (status === 'ok') {
      check(
        '通过时退出码为 0 且耗时可见',
        compiled.data?.exitCode === 0 && compiled.data?.durationMs > 0,
        `exit=${compiled.data?.exitCode} · ${((compiled.data?.durationMs ?? 0) / 1000).toFixed(1)}s · ${compiled.data?.command ?? ''}`.slice(0, 160),
      );
    } else {
      // 失败 / 超时 / 没有构建工具都算「没通过」，但必须给出原因，绝不能含糊成「成功」
      check('没通过时必须说明原因', Boolean(compiled.data?.note), compiled.data?.note ?? '（没有 note）');
      note(`编译未通过：status=${status}｜${compiled.data?.note ?? ''}`);
      if (status === 'failed') {
        check('失败时给出了结构化诊断', (compiled.data?.issues ?? []).length > 0, `${compiled.data?.issues?.length ?? 0} 条`);
      }
    }
  }

  section('13. 校验磁盘上的文件真的变了');
  const after = await call(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(TARGET_FILE)}`, { token });
  const afterText = after.data?.content ?? '';
  check('文件读取成功', after.status === 200);
  check(
    '字段注入已消失',
    !afterText.includes('@Autowired'),
    afterText.includes('@Autowired') ? '仍然存在' : '@Autowired 已移除',
  );
  check('已是 private final 字段', afterText.includes('private final UserRepository userRepository'));
  check('新增了构造器', /public UserService\(UserRepository userRepository\)/.test(afterText));
  check('文件内容确实发生了变化', afterText !== beforeText, `${beforeText.length} → ${afterText.length} 字符`);

  stream.close();

  section('14. 会话历史已持久化');
  const messages = await call(`/api/chat/sessions/${sessionId}/messages`, { token });
  const roles = (messages.data ?? []).map((message) => message.role);
  check('历史中同时存在 user 与 assistant', roles.includes('user') && roles.includes('assistant'), roles.join(','));
  const patchList = await call(`/api/chat/sessions/${sessionId}/patches`, { token });
  check('补丁列表可读', patchList.status === 200, `${(patchList.data ?? []).length} 个补丁`);

  summary();
}

function summary() {
  emit(`\n\u001b[1m结果：${pass} 通过 / ${fail} 失败\u001b[0m`);
  if (fail === 0) {
    emit('\u001b[32m全部通过。\u001b[0m');
  }
  if (REPORT_FILE) {
    try {
      writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
    } catch (error) {
      console.error(`写入报告失败：${error.message}`);
    }
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  emit(`\n\u001b[31m自测异常中断：${error.message}\u001b[0m`);
  summary();
});
