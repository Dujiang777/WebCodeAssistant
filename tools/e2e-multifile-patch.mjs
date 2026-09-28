#!/usr/bin/env node
/**
 * 多文件补丁与变更说明的端到端验证（功能 78.1 / 78.2）。
 *
 * 覆盖链路：
 *   1. mock 模型一次 propose_patch 提交两文件 diff（已有文件重构段 + 新建文件段）；
 *   2. 后端把多文件 diff 拆成两条独立补丁记录，逐条推 patch 事件，均带 summary；
 *   3. patch 事件与补丁列表接口都透出 summary（变更说明）；
 *   4. apply-all 批量应用全部成功，磁盘文件真的变化（重构生效 + 新文件出现）。
 *
 * 用法：
 *   node tools/e2e-multifile-patch.mjs
 *   BASE_URL=http://127.0.0.1:8080 node tools/e2e-multifile-patch.mjs
 *
 * 退出码：0 = 全部通过，1 = 有失败项。
 */

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
import { solveCaptcha, clearIpCounters } from './lib-captcha.mjs';

// IP 限流窗口 10 分钟：连续跑几轮回归会把窗口打满（防线正确工作），
// 先清掉本脚本的计数器保证回归确定性。
await clearIpCounters();
const TARGET_FILE = 'src/main/java/com/demo/UserService.java';
const NEW_FILE = 'docs/refactor-notes.md';

let pass = 0;
let fail = 0;

function ok(name, detail) {
  pass += 1;
  console.log(`  \u001b[32mOK\u001b[0m ${name}${detail ? ` \u2014 ${detail}` : ''}`);
}

function bad(name, detail) {
  fail += 1;
  console.log(`  \u001b[31mXX\u001b[0m ${name}${detail ? ` \u2014 ${detail}` : ''}`);
}

function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, detail);
}

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

async function openStream(sessionId, token) {
  const controller = new AbortController();
  const state = { events: [] };
  const response = await fetch(`${BASE}/api/chat/sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE HTTP ${response.status}`);
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
              state.events.push(JSON.parse(line.slice(5).trim()));
            } catch {
              // 忽略无法解析的帧
            }
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // 主动 abort 走这里
    }
  })();
  return { state, close: () => controller.abort() };
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

async function main() {
  console.log('\u001b[1m多文件补丁 e2e（78.1 summary / 78.2 拆分落库）\u001b[0m');

  const health = await call('/api/health');
  check('后端健康', health.status === 200 && health.data?.modelConfigured === true);
  if (health.status !== 200) return;

  const username = `multi_${Math.random().toString(36).slice(2, 8)}`;
  const auth = await call('/api/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.com`, password: 'multi1234', ...(await solveCaptcha(BASE)) },
  });
  const token = auth.data?.accessToken;
  check('注册并拿到 JWT', typeof token === 'string' && token.length > 20, `HTTP ${auth.status}`);
  if (!token) return;

  const created = await call('/api/workspaces', {
    method: 'POST',
    token,
    body: { sample: true, name: `multi-${Date.now().toString().slice(-5)}` },
  });
  const workspaceId = created.data?.id;
  check('创建示例工作区', created.status === 201 && typeof workspaceId === 'number');
  if (!workspaceId) return;

  const session = await call('/api/chat/sessions', { method: 'POST', token, body: { workspaceId } });
  const sessionId = session.data?.id;
  check('创建会话', session.status === 201 && typeof sessionId === 'number');
  if (!sessionId) return;

  const stream = await openStream(sessionId, token);

  const sent = await call(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    token,
    body: {
      content: '请把这个类一次改好几个文件：字段注入改成构造器注入，再补一份说明文档。',
      currentFile: TARGET_FILE,
    },
  });
  check('消息已受理（202）', sent.status === 202, `HTTP ${sent.status}`);

  try {
    const done = await waitUntil(
      () => stream.state.events.find((event) => event.type === 'done') ?? null,
      90_000,
      'done 事件',
    ).catch(() => null);
    check('回合完成（done）', done !== null);

    const patchEvents = stream.state.events.filter((event) => event.type === 'patch');
    check('一次提交拆出 2 个补丁事件', patchEvents.length === 2, `收到 ${patchEvents.length} 个`);
    check(
      '两个补丁分别是目标文件与新建文件',
      patchEvents.some((event) => event.file === TARGET_FILE) &&
        patchEvents.some((event) => event.file === NEW_FILE),
      patchEvents.map((event) => event.file).join(' , '),
    );
    check(
      '每个补丁事件都带变更说明（summary）',
      patchEvents.length === 2 &&
        patchEvents.every((event) => typeof event.summary === 'string' && event.summary.length > 4),
      patchEvents.map((event) => String(event.summary ?? '').slice(0, 24)).join(' / '),
    );
    check(
      '两个补丁的 diff 段各自只含一个文件头',
      patchEvents.every((event) => {
        const heads = String(event.diff ?? '').match(/^--- /gm) ?? [];
        return heads.length === 1;
      }),
    );

    const listed = await call(`/api/chat/sessions/${sessionId}/patches`, { token });
    const pending = (listed.data ?? []).filter((patch) => patch.status === 'pending');
    check('补丁列表可见 2 条 pending', pending.length === 2, `共 ${(listed.data ?? []).length} 条`);
    check(
      '列表接口也透出 summary',
      pending.every((patch) => typeof patch.summary === 'string' && patch.summary.length > 4),
    );

    const applied = await call(`/api/chat/sessions/${sessionId}/patches/apply-all`, {
      method: 'POST',
      token,
      body: { acknowledgeFlag: true },
    });
    check(
      '批量应用全部成功',
      applied.status === 200 && applied.data?.applied === 2 && applied.data?.failed === 0,
      `applied=${applied.data?.applied} failed=${applied.data?.failed}`,
    );

    const refactored = await call(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(TARGET_FILE)}`,
      { token },
    );
    check(
      '目标文件已改为构造器注入',
      typeof refactored.data?.content === 'string' &&
        refactored.data.content.includes('public UserService(UserRepository') &&
        !refactored.data.content.includes('@Autowired'),
    );
    const newFile = await call(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(NEW_FILE)}`, {
      token,
    });
    check(
      '新建文件已落盘且含标题',
      newFile.status === 200 && String(newFile.data?.content ?? '').includes('# 重构说明'),
      `HTTP ${newFile.status}`,
    );
  } finally {
    stream.close();
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('脚本异常：', error);
  process.exit(1);
});
