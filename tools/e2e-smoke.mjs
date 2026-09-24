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
  let auth = await call('/api/auth/register', { method: 'POST', body: { username, email: `${username}@example.com`, password } });
  check('注册新账号', auth.status === 201 || auth.status === 200, `HTTP ${auth.status}`);
  if (auth.status !== 201 && auth.status !== 200) {
    auth = await call('/api/auth/login', { method: 'POST', body: { username, password } });
    check('改用登录', auth.status === 200, `HTTP ${auth.status}`);
  }
  const token = auth.data?.accessToken;
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

  section('11. 应用补丁（含特性开关闸门）');
  if (!patchEvent) {
    note('没有补丁可应用，跳过。');
  } else {
    // 功能 16：改动了行为的补丁，必须先确认「开关关闭时的旧路径」，否则一律拦下。
    const flagInfo = await call(`/api/patches/${patchEvent.id}/feature-flag`, { token });
    check('能查到补丁的特性开关信息', flagInfo.status === 200, `HTTP ${flagInfo.status}`);
    check('该补丁被判定为需要开关', flagInfo.data?.required === true, `required=${flagInfo.data?.required}`);
    check(
      '给出了开 / 关两种运行说明',
      Boolean(flagInfo.data?.openRunbook) && Boolean(flagInfo.data?.closedRunbook),
      `关=${String(flagInfo.data?.closedRunbook ?? '').slice(0, 28)}`,
    );

    const noAck = await call(`/api/patches/${patchEvent.id}/apply`, { method: 'POST', token });
    check(
      '没确认开关时应用被拦下',
      noAck.status === 409 && noAck.data?.code === 'FLAG_ACK_REQUIRED',
      `HTTP ${noAck.status} ${noAck.data?.code ?? ''}`,
    );

    const applied = await call(`/api/patches/${patchEvent.id}/apply`, {
      method: 'POST',
      token,
      body: { acknowledgeFlag: true },
    });
    check('确认开关后应用成功', applied.status === 200, `HTTP ${applied.status} ${applied.data?.code ?? ''}`);
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

  section('15. 仓库宪法（读 / 模板 / 存 / 撤回 / 再存）');
  const c0 = await call(`/api/workspaces/${workspaceId}/constitution`, { token });
  check('GET constitution 可用', c0.status === 200, `HTTP ${c0.status}`);
  check('新工作区没有宪法（exists=false）', c0.data?.exists === false, `exists=${c0.data?.exists}`);
  const tpl = await call(`/api/workspaces/${workspaceId}/constitution/template`, { token });
  check('宪法模板可取', tpl.status === 200 && (tpl.data?.content ?? '').includes('仓库宪法'), `${(tpl.data?.content ?? '').length} 字符`);
  const cSaved = await call(`/api/workspaces/${workspaceId}/constitution`, {
    method: 'PUT',
    token,
    body: { content: '# 仓库宪法\n\n- 统一构造器注入，禁止字段 @Autowired\n- 任何行为变更必须附带测试\n' },
  });
  check('宪法保存成功', cSaved.status === 200 && cSaved.data?.exists === true, `exists=${cSaved.data?.exists}`);
  const c1 = await call(`/api/workspaces/${workspaceId}/constitution`, { token });
  check('宪法回读一致', (c1.data?.content ?? '').includes('禁止字段 @Autowired'));
  const cCleared = await call(`/api/workspaces/${workspaceId}/constitution`, {
    method: 'PUT',
    token,
    body: { content: '   ' },
  });
  check('空内容保存 = 撤回宪法', cCleared.data?.exists === false, `exists=${cCleared.data?.exists}`);
  await call(`/api/workspaces/${workspaceId}/constitution`, {
    method: 'PUT',
    token,
    body: { content: tpl.data?.content ?? '# 仓库宪法\n' },
  });
  note('已用模板内容恢复宪法（供后续人工查看）');

  section('16. Spring 地图（Bean / 端点 / 依赖注入）');
  const smap = await call(`/api/workspaces/${workspaceId}/spring-map`, { token });
  check('GET spring-map 可用', smap.status === 200, `HTTP ${smap.status}`);
  const sm = smap.data ?? {};
  check('扫描到了 Java 文件', (sm.scannedFiles ?? 0) > 0, `${sm.scannedFiles} 个`);
  const nodeNames = (sm.nodes ?? []).map((node) => node.name);
  check('识别出至少 3 个 Bean', nodeNames.length >= 3, nodeNames.join('、'));
  const controllerNode = (sm.nodes ?? []).find((node) => node.name === 'UserController');
  check('UserController 被识别为 Controller', controllerNode?.stereotype === 'Controller');
  check(
    'Controller 的 HTTP 端点已拼出类级前缀',
    (controllerNode?.endpoints ?? []).some((endpoint) => endpoint.startsWith('GET /api/users')),
    (controllerNode?.endpoints ?? []).join(' ; ').slice(0, 160),
  );
  check(
    '依赖注入边存在（UserService → UserRepository）',
    (sm.edges ?? []).some((edge) => edge.from === 'UserService' && edge.to === 'UserRepository'),
    `${(sm.edges ?? []).length} 条边`,
  );

  section('17. 变更预演 PR');
  if (!patchEvent) {
    note('没有补丁可预演，跳过。');
  } else {
    const pr = await call(`/api/patches/${patchEvent.id}/pr-preview`, { token });
    check('GET pr-preview 可用', pr.status === 200, `HTTP ${pr.status}`);
    const preview = pr.data ?? {};
    check('PR 标题非空且含变更字样', (preview.title ?? '').includes('变更'), preview.title ?? '');
    check('分支建议非空', Boolean(preview.branch), preview.branch ?? '');
    check('正文包含变更内容小节', (preview.body ?? '').includes('## 变更内容'));
    check(
      '审查清单 ≥ 3 项且状态合法',
      (preview.checklist ?? []).length >= 3 &&
        (preview.checklist ?? []).every((item) => ['ok', 'warn', 'bad', 'info'].includes(item.state)),
      `${(preview.checklist ?? []).length} 项`,
    );
    check(
      '清单包含宪法项（工作区已配置宪法）',
      (preview.checklist ?? []).some((item) => item.text === '仓库宪法' && item.state === 'ok'),
    );
    note(`标题：${preview.title}`);
  }

  section('18. 测试运行（测试失败驱动改代码的事实来源）');
  const testRun = await call(`/api/workspaces/${workspaceId}/test-run`, { method: 'POST', token });
  const tStatus = testRun.data?.status;
  check(
    'test-run 返回明确状态',
    ['ok', 'failed', 'timeout', 'unavailable', 'disabled'].includes(tStatus),
    `status=${tStatus}`,
  );
  if (tStatus === 'ok') {
    check(
      '示例项目测试通过且统计可见',
      (testRun.data?.totals?.run ?? 0) > 0,
      `run=${testRun.data?.totals?.run} failures=${testRun.data?.totals?.failures} errors=${testRun.data?.totals?.errors}`,
    );
    check('失败用例列表为空', (testRun.data?.failures ?? []).length === 0);
  } else if (tStatus === 'failed') {
    // 失败有两种形态，都算结构化输出：
    // a) surefire 跑了且有失败用例 → failures 非空；
    // b) 测试代码编译不过（如补丁改了构造器签名）→ failures 为空、issues 给出编译诊断。
    const failCount = (testRun.data?.failures ?? []).length;
    const issueCount = (testRun.data?.issues ?? []).length;
    check(
      '失败时给出了结构化明细（失败用例或编译诊断）',
      failCount > 0 || issueCount > 0,
      failCount > 0
        ? (testRun.data?.failures ?? []).map((failure) => failure.displayName).join('、').slice(0, 160)
        : `编译诊断 ${issueCount} 条：${(testRun.data?.issues ?? [])
            .map((issue) => `${issue.file}${issue.line ? ':' + issue.line : ''}`)
            .join('、')
            .slice(0, 140)}`,
    );
    if (failCount > 0) {
      note('示例测试本身失败了 —— 需要修样例或环境，请看报告');
    } else {
      note('补丁改了构造器签名导致测试代码编译不过 —— issues 已给出诊断，符合「测试驱动修代码」的输入形态');
    }
  } else {
    check('未执行时说明了原因', Boolean(testRun.data?.note), testRun.data?.note ?? '');
    note(`测试未执行：${testRun.data?.note ?? ''}`);
  }

  section('19. 快照与回滚（应用补丁前自动打点）');
  const snapList = await call(`/api/workspaces/${workspaceId}/snapshots`, { token });
  check('GET snapshots 可用', snapList.status === 200, `HTTP ${snapList.status}`);
  const snaps = snapList.data ?? [];
  // 取「最早」的自动快照 —— 它才是真正的补丁应用前时点
  const autoSnap = snaps
    .filter((snapshot) => snapshot.kind === 'auto' && snapshot.patchId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  check(
    '应用补丁时产生了自动快照',
    Boolean(autoSnap),
    autoSnap ? `${autoSnap.label} · ${autoSnap.fileCount} 文件` : '没有 auto 快照',
  );
  const manualSnap = await call(`/api/workspaces/${workspaceId}/snapshots`, {
    method: 'POST',
    token,
    body: { label: 'e2e 手动快照' },
  });
  check(
    '手动快照可创建',
    manualSnap.status === 200 && manualSnap.data?.kind === 'manual',
    `kind=${manualSnap.data?.kind}`,
  );
  if (autoSnap) {
    // 回滚到「补丁应用前」→ 补丁的修改应当消失
    const restored = await call(`/api/workspaces/${workspaceId}/snapshots/${autoSnap.id}/restore`, {
      method: 'POST',
      token,
    });
    check('回滚到自动快照成功', restored.status === 200, `HTTP ${restored.status}`);
    const reverted = await call(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent('src/main/java/com/demo/UserService.java')}`, { token });
    const revertedText = typeof reverted.data === 'string' ? reverted.data : (reverted.data?.content ?? '');
    check('回滚后补丁的修改已消失（@Autowired 回来了）', revertedText.includes('@Autowired'), '');
    // 再回到手动快照（补丁已应用的状态），恢复工作区
    const restored2 = await call(`/api/workspaces/${workspaceId}/snapshots/${manualSnap.data?.id}/restore`, {
      method: 'POST',
      token,
    });
    check('回滚到手动快照成功', restored2.status === 200, `HTTP ${restored2.status}`);
    const again = await call(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent('src/main/java/com/demo/UserService.java')}`, { token });
    const againText = typeof again.data === 'string' ? again.data : (again.data?.content ?? '');
    check('恢复后补丁的修改重新生效', !againText.includes('@Autowired'), '');
    const deleted = await call(`/api/workspaces/${workspaceId}/snapshots/${manualSnap.data?.id}`, {
      method: 'DELETE',
      token,
    });
    check('快照可删除', [200, 204].includes(deleted.status), `HTTP ${deleted.status}`);
  }

  section('20. 批量应用（多文件自动改的落地点）');
  const applyAllEmpty = await call(`/api/chat/sessions/${sessionId}/patches/apply-all`, { method: 'POST', token });
  check(
    '没有待确认补丁时明确拒绝',
    applyAllEmpty.status === 400,
    `HTTP ${applyAllEmpty.status} ${(applyAllEmpty.data?.message ?? '').slice(0, 60)}`,
  );

  section('21. 语义检索（建索引 → 检索 → 命中）');
  const semStatus = await call(`/api/workspaces/${workspaceId}/semantic/status`, { token });
  check(
    '语义检索可用（embedding 模型已配置）',
    semStatus.status === 200 && semStatus.data?.available === true,
    `available=${semStatus.data?.available}`,
  );
  const reindexed = await call(`/api/workspaces/${workspaceId}/semantic/index`, { method: 'POST', token });
  check(
    '重建索引成功且块数 > 0',
    reindexed.status === 200 && (reindexed.data?.chunks ?? 0) > 0,
    `${reindexed.data?.chunks} 块`,
  );
  const searched = await call(`/api/workspaces/${workspaceId}/semantic/search`, {
    method: 'POST',
    token,
    body: { query: 'user register controller service', topK: 5 },
  });
  check('检索返回 ok', searched.data?.status === 'ok', `status=${searched.data?.status}`);
  const hits = searched.data?.hits ?? [];
  check('命中 ≥ 1 且带路径行号', hits.length >= 1 && Boolean(hits[0].path) && hits[0].startLine > 0, hits.map((hit) => `${hit.path}:${hit.startLine}`).join('、').slice(0, 120));
  check('分数按降序排列', hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score));

  section('22. 网页终端（受限执行，模型无此能力）');
  const termRun = await call(`/api/workspaces/${workspaceId}/terminal/run`, {
    method: 'POST',
    token,
    body: { command: 'echo hello-wca' },
  });
  check(
    'echo 命令执行成功',
    termRun.status === 200 && termRun.data?.exitCode === 0 && (termRun.data?.output ?? '').includes('hello-wca'),
    `exit=${termRun.data?.exitCode} output=${(termRun.data?.output ?? '').trim().slice(0, 40)}`,
  );
  const termChain = await call(`/api/workspaces/${workspaceId}/terminal/run`, {
    method: 'POST',
    token,
    body: { command: 'echo a && echo b' },
  });
  check(
    '命令链（&&）被拒绝',
    termChain.status === 400,
    `HTTP ${termChain.status}`,
  );
  const termMeta = await call(`/api/workspaces/${workspaceId}/terminal/run`, {
    method: 'POST',
    token,
    body: { command: 'echo %PATH%' },
  });
  check('环境变量展开（%）被拒绝', termMeta.status === 400, `HTTP ${termMeta.status}`);

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
