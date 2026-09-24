#!/usr/bin/env node
/**
 * 批 4（功能 13-16）专项端到端自检。
 *
 * 与 tools/e2e-smoke.mjs 并列而不是塞进去：那一份是「主链路」契约（79 条），
 * 这一份只验证本轮新增的四处能力，两边都不必为对方改断言。
 *
 * 覆盖：
 *   功能 13 Agent 工位      —— 一次真实回合之后，工位上必须有时间线 / 摊开的文件 / 草稿
 *   功能 14 工具级闸门      —— propose_patch 必须被拦下成 tool_gate 事件，且能改参数放行
 *   功能 15 平行宇宙        —— 影子推演产出可校验 diff，丢弃/采纳两条结局都能走通
 *   功能 16 特性开关        —— .java 行为改动 must be flagged，未确认时 apply 必须 409
 *
 * 用法：
 *   node tools/e2e-features-13-16.mjs
 *   BASE_URL=http://127.0.0.1:8080 node tools/e2e-features-13-16.mjs
 *   REPORT_FILE=.../features-13-16.txt node tools/e2e-features-13-16.mjs
 *
 * 退出码：0 = 全绿，1 = 有失败项。
 */

import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const TARGET_FILE = 'src/main/java/com/demo/UserService.java';
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

function section(title) {
  emit(`\n\u001b[1m${title}\u001b[0m`);
}

function note(text) {
  emit(`    \u001b[90m${text}\u001b[0m`);
}

// ------------------------------------------------------------------ HTTP

async function call(path, { method = 'GET', body, token } = {}) {
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
  return { status: response.status, data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(120);
  }
}

// ------------------------------------------------------------------- SSE

/**
 * 收集一段时间内的事件流。用 fetch + ReadableStream 自己解析 ——
 * 与前端 lib/sse.ts 同一套帧格式（data: 行 + 空行分隔）。
 */
function collectStream(sessionId, token, sink, onClose) {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`${BASE}/api/chat/sessions/${sessionId}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        onClose?.(new Error(`事件流连接失败（${response.status}）`));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trimStart();
            try {
              sink(JSON.parse(payload));
            } catch {
              /* 忽略解析不了的心跳 */
            }
          }
          sep = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { stop: () => controller.abort() };
}

// ------------------------------------------------------------------ 主体

async function main() {
  section('准备：注册 + 建样例工作区 + 开会话');

  const username = `e2e_b4_${Date.now().toString(36)}`;
  const password = 'Passw0rd!23';

  const reg = await call('/api/auth/register', { method: 'POST', body: { username, password } });
  check('注册新用户', reg.status === 201 || reg.status === 200, `HTTP ${reg.status}`);
  const token = reg.data?.token;
  if (!token) throw new Error('拿不到 token，后续无法继续');

  const ws = await call('/api/workspaces', { method: 'POST', body: { name: 'demo-java', sample: true }, token });
  check('创建样例工作区', ws.status === 201 || ws.status === 200, `HTTP ${ws.status}`);
  const workspaceId = ws.data?.id;

  const session = await call('/api/chat/sessions', { method: 'POST', body: { workspaceId }, token });
  check('创建会话', session.status === 201 || session.status === 200, `HTTP ${session.status}`);
  const sessionId = session.data?.id;

  // ---------------------------------------------------------------- 功能 14 策略

  section('功能 14 · 闸门策略与闸门列表');

  const policy0 = await call(`/api/chat/sessions/${sessionId}/gate-policy`, { token });
  check('读取默认策略', policy0.status === 200, `HTTP ${policy0.status}`);
  check('默认策略是 writes（只拦写操作）', policy0.data?.policy === 'writes', `policy=${policy0.data?.policy}`);

  const policyStrict = await call(`/api/chat/sessions/${sessionId}/gate-policy`, {
    method: 'PUT',
    body: { policy: 'strict' },
    token,
  });
  check('切到 strict 生效', policyStrict.data?.policy === 'strict', `policy=${policyStrict.data?.policy}`);

  const policyBad = await call(`/api/chat/sessions/${sessionId}/gate-policy`, {
    method: 'PUT',
    body: { policy: '随便写点什么' },
    token,
  });
  check('非法策略被归一化成 writes', policyBad.data?.policy === 'writes', `policy=${policyBad.data?.policy}`);

  const gates0 = await call(`/api/chat/sessions/${sessionId}/gates`, { token });
  check('初始没有等待中的闸门', gates0.status === 200 && Array.isArray(gates0.data) && gates0.data.length === 0,
    `count=${Array.isArray(gates0.data) ? gates0.data.length : 'n/a'}`);

  // ---------------------------------------------------------------- 功能 13 工位（空态）

  section('功能 13 · 工位初始态');

  const desk0 = await call(`/api/workspaces/${workspaceId}/desk?sessionId=${sessionId}`, { token });
  check('工位可读', desk0.status === 200, `HTTP ${desk0.status}`);
  check('工位初始为空闲', desk0.data?.phase === 'idle', `phase=${desk0.data?.phase}`);
  check('工位初始 0 次工具调用', desk0.data?.toolCalls === 0, `toolCalls=${desk0.data?.toolCalls}`);
  check('工位带 phaseLabel 人话字段', typeof desk0.data?.phaseLabel === 'string' && desk0.data.phaseLabel.length > 0,
    `phaseLabel=${desk0.data?.phaseLabel}`);

  const deskOtherWs = await call(`/api/workspaces/${workgroupId(workspaceId)}/desk?sessionId=${sessionId}`, { token });
  check('工位接口校验工作区归属（越权返回 4xx）', deskOtherWs.status >= 400, `HTTP ${deskOtherWs.status}`);

  // ---------------------------------------------------------------- 功能 14 全链路：拦下 → 改参数放行

  section('功能 14 · 一次真实回合：propose_patch 被拦下、改参数放行');

  await call(`/api/chat/sessions/${sessionId}/gate-policy`, { method: 'PUT', body: { policy: 'writes' }, token });

  const events = [];
  const stream = collectStream(sessionId, token, (event) => events.push(event));
  await sleep(600);

  const sent = await call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: {
      content: '把 UserService 的字段注入改成构造器注入，直接给我补丁。',
      currentFile: TARGET_FILE,
      mode: 'deliver',
    },
    token,
  });
  check('发送消息被受理', sent.status === 200 || sent.status === 202, `HTTP ${sent.status}`);

  const gateEvent = await waitUntil(() => events.find((event) => event.type === 'tool_gate'), 45000,
    'propose_patch 触发 tool_gate 事件');
  check('闸门事件带 gateId', typeof gateEvent.gateId === 'string' && gateEvent.gateId.length > 0,
    `gateId=${String(gateEvent.gateId).slice(0, 8)}…`);
  check('闸门事件带人话意图（它想干什么）', typeof gateEvent.intent === 'string' && gateEvent.intent.includes('补丁'),
    `intent=${gateEvent.intent}`);
  check('闸门事件带拦截理由', typeof gateEvent.reason === 'string' && gateEvent.reason.length > 0,
    `reason=${gateEvent.reason}`);
  check('闸门事件带超时时刻', typeof gateEvent.expiresAt === 'number' && gateEvent.expiresAt > Date.now(),
    `expiresAt 在未来`);
  note(`被拦下的工具：${gateEvent.tool}`);

  const gates1 = await call(`/api/chat/sessions/${sessionId}/gates`, { token });
  check('等待中的闸门能在 REST 侧查到（刷新页面可恢复卡片）',
    Array.isArray(gates1.data) && gates1.data.some((item) => item.gateId === gateEvent.gateId),
    `count=${Array.isArray(gates1.data) ? gates1.data.length : 'n/a'}`);

  // 改参数放行：动 file 之外的键（summary），验证「人工改过的键才生效」
  const approve = await call(`/api/chat/sessions/${sessionId}/gates/${gateEvent.gateId}/approve`, {
    method: 'POST',
    body: { args: { summary: '（人工改过）构造器注入改造' }, note: 'e2e 放行' },
    token,
  });
  check('改参数放行成功', approve.status === 200, `HTTP ${approve.status}`);

  const resolved = await waitUntil(
    () => events.find((event) => event.type === 'gate_resolved' && event.gateId === gateEvent.gateId),
    15000,
    'gate_resolved 事件',
  );
  check('放行后推送 gate_resolved', resolved.decision === 'approved', `decision=${resolved.decision}`);

  const doneEvent = await waitUntil(() => events.find((event) => event.type === 'done'), 60000, '回合结束');
  // messageId 在事件里是字符串（前端自己 Number() 一下）——这里只校验它是合法数字串
  check('回合正常结束', /^\d+$/.test(String(doneEvent.messageId)), `messageId=${doneEvent.messageId}`);
  stream.stop();

  // ---------------------------------------------------------------- 功能 13：工位有内容了

  section('功能 13 · 回合之后的工位状态');

  const desk1 = await call(`/api/workspaces/${workspaceId}/desk?sessionId=${sessionId}`, { token });
  check('工位记录了工具调用次数', (desk1.data?.toolCalls ?? 0) > 0, `toolCalls=${desk1.data?.toolCalls}`);
  check('工位有行为时间线', Array.isArray(desk1.data?.timeline) && desk1.data.timeline.length > 0,
    `timeline=${desk1.data?.timeline?.length ?? 0} 条`);
  check('工位时间线条目带中文动作名', typeof desk1.data?.timeline?.[0]?.label === 'string' &&
    desk1.data.timeline[0].label.length > 0, `label=${desk1.data?.timeline?.[0]?.label}`);
  check('工位展开了文件（摊在桌上）', Array.isArray(desk1.data?.openFiles) && desk1.data.openFiles.length > 0,
    `openFiles=${desk1.data?.openFiles?.length ?? 0}`);
  check('工位草稿区记录了这次 diff', Array.isArray(desk1.data?.drafts) && desk1.data.drafts.length > 0,
    `drafts=${desk1.data?.drafts?.length ?? 0}`);
  check('工位光标落在目标文件上', String(desk1.data?.cursorFile ?? '').includes('UserService.java'),
    `cursorFile=${desk1.data?.cursorFile}`);
  check('desk SSE 事件在回合中推送过（整块快照）', events.some((event) => event.type === 'desk'),
    `desk 事件 ${events.filter((e) => e.type === 'desk').length} 条`);

  // ---------------------------------------------------------------- 功能 16：特性开关

  section('功能 16 · 特性开关强制包裹');

  const patches = await call(`/api/chat/sessions/${sessionId}/patches`, { token });
  const pending = (patches.data ?? []).filter((patch) => patch.status === 'pending');
  check('回合产出了待确认补丁', pending.length > 0, `${pending.length} 个`);
  const patch = pending[0];
  if (patch) {
    const flag = await call(`/api/patches/${patch.id}/feature-flag`, { token });
    check('能读到补丁的开关语义', flag.status === 200, `HTTP ${flag.status}`);
    check('改动 .java 行为的补丁被判定为必须包开关', flag.data?.required === true,
      `required=${flag.data?.required} / reason=${flag.data?.reason}`);
    check('给出建议开关键名', typeof flag.data?.flagKey === 'string' && flag.data.flagKey.includes('user-service'),
      `flagKey=${flag.data?.flagKey}`);
    check('给出「打开时」的运行说明', typeof flag.data?.openRunbook === 'string' && flag.data.openRunbook.length > 0,
      `${String(flag.data?.openRunbook).slice(0, 34)}…`);
    check('给出「关闭时」的旧路径说明', typeof flag.data?.closedRunbook === 'string' && flag.data.closedRunbook.length > 0,
      `${String(flag.data?.closedRunbook).slice(0, 34)}…`);
    check('保留了开关关闭时的旧实现代码', typeof flag.data?.legacyCode === 'string' && flag.data.legacyCode.length > 0,
      `${String(flag.data?.legacyCode).split('\n').length} 行`);
    check('给出上线时要加的配置行', typeof flag.data?.configLine === 'string' && flag.data.configLine.length > 0,
      `configLine=${flag.data?.configLine}`);
    check('给出包裹后的代码骨架', typeof flag.data?.wrappedSnippet === 'string' && flag.data.wrappedSnippet.length > 0,
      `${String(flag.data?.wrappedSnippet).split('\n').length} 行骨架`);

    const applyNoAck = await call(`/api/patches/${patch.id}/apply`, { method: 'POST', body: {}, token });
    check('未确认开关时应用被挡下（409 FLAG_ACK_REQUIRED）',
      applyNoAck.status === 409 && applyNoAck.data?.code === 'FLAG_ACK_REQUIRED',
      `HTTP ${applyNoAck.status} / code=${applyNoAck.data?.code}`);
    check('挡下时给出可读原因', typeof applyNoAck.data?.message === 'string' && applyNoAck.data.message.includes('开关'),
      `message=${applyNoAck.data?.message}`);
    note('真正带 acknowledgeFlag 的应用放到脚本末尾 —— 它会改写文件，得先让 What-if 在原始文件上做实验');
  } else {
    bad('没有待确认补丁，功能 16 无法验证', 'skip');
  }

  // ---------------------------------------------------------------- 功能 15：平行宇宙

  section('功能 15 · 平行宇宙（丢弃与采纳两条结局）');

  const list0 = await call(`/api/workspaces/${workspaceId}/whatif`, { token });
  check('平行宇宙列表可读且初始为空', list0.status === 200 && Array.isArray(list0.data) && list0.data.length === 0,
    `count=${Array.isArray(list0.data) ? list0.data.length : 'n/a'}`);

  const ask = await call(`/api/workspaces/${workspaceId}/whatif`, {
    method: 'POST',
    body: {
      sessionId,
      question: '假如把 UserService 的字段注入换成构造器注入，同时把 countActive 改成 Stream 写法，会是什么样子？',
      file: TARGET_FILE,
    },
    token,
  });
  check('开一个平行宇宙', ask.status === 200, `HTTP ${ask.status}`);
  const branch = ask.data;
  check('分支带状态', typeof branch?.status === 'string', `status=${branch?.status}`);

  if (branch?.status === 'ready') {
    check('推演产出了 diff', typeof branch.diff === 'string' && branch.diff.includes('@@'),
      `diff ${String(branch.diff).length} 字符`);
    check('左右两栏内容不同（真的改了东西）', branch.mainText !== branch.shadowText,
      `主线 ${String(branch.mainText).length} 字符 → 影子 ${String(branch.shadowText).length} 字符`);
    check('改动量是真重构级别（不是贴一行注释糊弄）', branch.added + branch.removed >= 3,
      `+${branch.added} / -${branch.removed}`);
    check('影子文本里确实换成了构造器注入', branch.shadowText.includes('public UserService(UserRepository'),
      '左栏还是 @Autowired 字段，右栏已经是构造器');
    check('平行宇宙没有碰主线文件', branch.mainText.includes('@Autowired'),
      '主线内容原样返回，改动只存在于影子里');
    note(`分支 id = ${branch.id}`);
  } else {
    note(`模型这次没给出可解析的 diff（status=${branch?.status}）：${branch?.note ?? ''}`);
    check('不可用时必须给出 note 说明', typeof branch?.note === 'string' && branch.note.length > 0, `note 非空`);
  }

  const getBranch = await call(`/api/workspaces/${workspaceId}/whatif/${branch.id}`, { token });
  check('能按 id 回查分支', getBranch.status === 200 && getBranch.data?.id === branch.id, `HTTP ${getBranch.status}`);

  const discard = await call(`/api/workspaces/${workspaceId}/whatif/${branch.id}/discard`, { method: 'POST', token });
  check('丢弃分支（默认结局）', discard.status === 200 && discard.data?.status === 'discarded',
    `status=${discard.data?.status}`);

  // 第二个分支：走采纳路径
  const ask2 = await call(`/api/workspaces/${workspaceId}/whatif`, {
    method: 'POST',
    body: {
      sessionId,
      question: '给 UserService 加上用户名占用校验，用构造器注入。',
      file: TARGET_FILE,
    },
    token,
  });
  check('再开一个平行宇宙', ask2.status === 200 && typeof ask2.data?.id === 'string', `HTTP ${ask2.status}`);

  if (ask2.data?.status === 'ready') {
    const adopt = await call(`/api/workspaces/${workspaceId}/whatif/${ask2.data.id}/adopt`, { method: 'POST', token });
    check('采纳到主线', adopt.status === 200, `HTTP ${adopt.status}`);
    check('采纳产出一条待确认补丁（不直接写盘）',
      typeof adopt.data?.patchId === 'string' && adopt.data.patchId.length > 0,
      `patchId=${String(adopt.data?.patchId).slice(0, 8)}…`);

    const after = await call(`/api/chat/sessions/${sessionId}/patches`, { token });
    const adopted = (after.data ?? []).find((item) => item.id === adopt.data.patchId);
    check('采纳出的补丁确实落在主线待确认区', adopted !== undefined && adopted.status === 'pending',
      `status=${adopted?.status}`);

    const branchAfter = await call(`/api/workspaces/${workspaceId}/whatif/${ask2.data.id}`, { token });
    check('分支状态变为 adopted', branchAfter.data?.status === 'adopted', `status=${branchAfter.data?.status}`);

    // 清场：把采纳出来的补丁拒绝掉，避免污染后续断言
    if (adopt.data?.patchId) {
      const rejected = await call(`/api/patches/${adopt.data.patchId}/reject`, { method: 'POST', token });
      check('清场：拒绝采纳出的补丁', rejected.status === 200, `HTTP ${rejected.status}`);
    }
  } else {
    note(`第二个分支不可用（status=${ask2.data?.status}），跳过采纳链路`);
    check('不可用时必须给出 note 说明', typeof ask2.data?.note === 'string' && ask2.data.note.length > 0, 'note 非空');
  }

  const listFinal = await call(`/api/workspaces/${workspaceId}/whatif`, { token });
  check('平行宇宙列表记录了两次实验', Array.isArray(listFinal.data) && listFinal.data.length === 2,
    `count=${Array.isArray(listFinal.data) ? listFinal.data.length : 'n/a'}`);

  // ---------------------------------------------------------------- 收尾：真应用一次

  section('收尾 · 带确认地应用补丁，并验证磁盘真的变了');

  if (patch) {
    const applyAck = await call(`/api/patches/${patch.id}/apply`, {
      method: 'POST',
      body: { acknowledgeFlag: true },
      token,
    });
    check('带 acknowledgeFlag=true 可以应用', applyAck.status === 200, `HTTP ${applyAck.status}`);
    check('应用后状态是 applied', applyAck.data?.status === 'applied', `status=${applyAck.data?.status}`);

    const readBack = await call(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(TARGET_FILE)}`,
      { token },
    );
    const text = String(readBack.data?.content ?? '');
    check('磁盘上的文件真的变了（@Autowired 已消失）', readBack.status === 200 && !text.includes('@Autowired'),
      `${text.split('\n').length} 行`);
    check('改成了构造器注入', text.includes('public UserService(UserRepository'),
      '落盘内容含构造器');
  }

  // ---------------------------------------------------------------- 越权

  section('越权：四个新接口都必须按用户隔离');

  const stranger = await call('/api/auth/register', {
    method: 'POST',
    body: { username: `${username}_x`, password },
  });
  const strangerToken = stranger.data?.token;
  const deskHack = await call(`/api/workspaces/${workspaceId}/desk?sessionId=${sessionId}`, { token: strangerToken });
  check('陌生人读不到别人的工位', deskHack.status >= 400, `HTTP ${deskHack.status}`);
  const whatIfHack = await call(`/api/workspaces/${workspaceId}/whatif`, { token: strangerToken });
  check('陌生人读不到别人的平行宇宙', whatIfHack.status >= 400, `HTTP ${whatIfHack.status}`);
  const gateHack = await call(`/api/chat/sessions/${sessionId}/gates`, { token: strangerToken });
  check('陌生人读不到别人的闸门', gateHack.status >= 400, `HTTP ${gateHack.status}`);
  const flagHack = await call(`/api/patches/${patch?.id ?? '00000000-0000-0000-0000-000000000000'}/feature-flag`, {
    token: strangerToken,
  });
  check('陌生人读不到别人的补丁开关', flagHack.status >= 400, `HTTP ${flagHack.status}`);
}

/** 故意换一个不存在的工作区 id，用于验证归属校验。 */
function workgroupId(current) {
  return Number(current) + 100000;
}

// ------------------------------------------------------------------ 汇总

function summary() {
  const line = `\n结果：\u001b[32m${pass} 通过\u001b[0m / \u001b[31m${fail} 失败\u001b[0m`;
  emit(line);
  if (REPORT_FILE) {
    writeFileSync(REPORT_FILE, `web-code-assistant 批 4（功能 13-16）自检报告\n` +
      `时间：${new Date().toISOString()}\n目标：${BASE}\n\n` + report.join('\n') + '\n', 'utf8');
  }
}

try {
  await main();
} catch (error) {
  bad('脚本异常中断', error instanceof Error ? error.message : String(error));
} finally {
  summary();
  process.exitCode = fail === 0 ? 0 : 1;
}
