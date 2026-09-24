#!/usr/bin/env node
/**
 * 端到端自测：商业级账号体系 + AI 积分系统。
 *
 * 与 e2e-smoke.mjs 的分工：那个脚本管「编码助手本体」（工作区 / 补丁 / 编译 / 检索），
 * 这个脚本管「让它可以上线」的那一层 —— 账号、安全、计费。
 *
 * 用法：
 *   node tools/e2e-auth-credits.mjs
 *   BASE_URL=http://127.0.0.1:8080 node tools/e2e-auth-credits.mjs
 *   REPORT_FILE=report.txt node tools/e2e-auth-credits.mjs
 *
 * 退出码：0 = 全部通过，1 = 有失败项。
 *
 * 这个脚本里有几条断言是「故意去打自己的脸」的，它们才是重点：
 *   - 重复回调支付 → 只能到账一次；
 *   - 用同一个刷新令牌换两次 → 第二次触发全量吊销（重放检测）；
 *   - 账号锁定期内即使密码正确也进不去；
 *   - 「用户不存在」与「密码错误」返回同一句话（防枚举）。
 * 把这些去掉，剩下的就只是一份「接口能通」的清单。
 */

import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const REPORT_FILE = process.env.REPORT_FILE ?? null;
/** 每次运行都换一批账号，避免与上一轮的数据打架（尤其是锁定与冷却这两条）。 */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ADMIN_USERNAME = 'e2e_admin';
const ADMIN_PASSWORD = 'e2eAdmin2026';

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

/** 断言一个请求「必须失败且错误码正确」。 */
function expectError(name, result, status, code) {
  const gotCode = result.data && typeof result.data === 'object' ? result.data.code : null;
  check(name, result.status === status && gotCode === code,
    `HTTP ${result.status}${gotCode ? ` / ${gotCode}` : ''}${gotCode === code ? '' : `（期望 ${status} / ${code}）`}`);
}

// ------------------------------------------------------------------ SSE

async function openStream(sessionId, token) {
  const controller = new AbortController();
  const state = { events: [], closed: false };
  const response = await fetch(`${BASE}/api/chat/sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`事件流建立失败：HTTP ${response.status}`);

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
              // 半包：忽略，等下一帧
            }
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // 主动关闭时抛 AbortError，属正常
    }
  })();

  return {
    events: () => state.events,
    waitFor(type, timeoutMs) {
      return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const hit = state.events.find((event) => event.type === type);
          if (hit) {
            clearInterval(timer);
            resolve(hit);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(null);
          }
        }, 150);
      });
    },
    close() {
      state.closed = true;
      controller.abort();
    },
  };
}

// ------------------------------------------------------------------ 辅助

async function register(username, email, password) {
  return call('/api/auth/register', { method: 'POST', body: { username, email, password } });
}

async function login(identifier, password) {
  return call('/api/auth/login', { method: 'POST', body: { username: identifier, password } });
}

async function ensureAdmin() {
  const created = await register(ADMIN_USERNAME, `${ADMIN_USERNAME}@example.com`, ADMIN_PASSWORD);
  // 注册后 role 才被引导配置提升，所以无论新建还是复用，都再登录一次把真实角色读回来
  if (created.status !== 201 && created.status !== 409) return created.data;
  const logged = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  return logged.data ?? created.data;
}

async function waitForHealth(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ================================================================== 主流程

async function main() {
  emit(`\u001b[1m端到端自检 · 账号体系 + 积分系统\u001b[0m  ${BASE}  (run=${RUN})`);

  if (!(await waitForHealth())) {
    bad('后端可达', `${BASE}/api/health 无响应`);
    return finish();
  }

  const userA = `auth_${RUN}`;
  const userB = `buddy_${RUN}`;
  const emailA = `${userA}@example.com`;
  const passA = 'Sea2026Token';
  const passA2 = 'Reef2026Token';

  // ---------------------------------------------------------------- 1. 注册
  section('1. 注册与邮箱验证');

  expectError('弱密码被拒（纯字母）',
    await register(`weak_${RUN}`, `weak_${RUN}@example.com`, 'onlyletters'),
    400, 'VALIDATION_FAILED');
  expectError('弱密码被拒（纯数字）',
    await register(`weak2_${RUN}`, `weak2_${RUN}@example.com`, '12345678'),
    400, 'VALIDATION_FAILED');
  expectError('非法用户名被拒',
    await register('ab', `short_${RUN}@example.com`, passA),
    400, 'VALIDATION_FAILED');
  expectError('非法邮箱被拒',
    await register(`badmail_${RUN}`, 'not-an-email', passA),
    400, 'VALIDATION_FAILED');

  const registered = await register(userA, emailA, passA);
  check('注册成功返回 201', registered.status === 201, `HTTP ${registered.status}`);
  const a = registered.data ?? {};
  check('注册直接下发 access token', typeof a.accessToken === 'string' && a.accessToken.length > 20);
  check('注册直接下发 refresh token', typeof a.refreshToken === 'string' && a.refreshToken.length > 20);
  check('access 有效期 2 小时', a.accessTokenExpiresIn === 7200, `${a.accessTokenExpiresIn}s`);
  check('refresh 有效期 30 天', a.refreshTokenExpiresIn === 30 * 24 * 3600, `${a.refreshTokenExpiresIn}s`);
  check('新账号邮箱未验证', a.emailVerified === false);
  check('dev 邮件通道回显验证令牌', typeof a.devVerifyToken === 'string' && a.devVerifyToken.length > 20);
  check('注册即赠送积分', a.credits > 0, `${a.credits} 分`);

  expectError('用户名重名被拒',
    await register(userA, `other_${RUN}@example.com`, passA), 409, 'CONFLICT');
  expectError('邮箱重复被拒',
    await register(`other_${RUN}`, emailA, passA), 409, 'EMAIL_TAKEN');
  expectError('邮箱大小写归一（同一个邮箱）',
    await register(`other2_${RUN}`, emailA.toUpperCase(), passA), 409, 'EMAIL_TAKEN');

  const meBefore = await call('/api/auth/me', { token: a.accessToken });
  check('me 返回邮箱未验证', meBefore.data?.emailVerified === false);
  check('me 带上余额', typeof meBefore.data?.credits === 'number', `${meBefore.data?.credits} 分`);

  const verified = await call('/api/auth/verify-email', { method: 'POST', body: { token: a.devVerifyToken } });
  check('邮箱验证成功', verified.status === 200, `HTTP ${verified.status}`);

  expectError('同一个验证令牌不能用两次',
    await call('/api/auth/verify-email', { method: 'POST', body: { token: a.devVerifyToken } }),
    401, 'TOKEN_INVALID');

  expectError('伪造的验证令牌被拒',
    await call('/api/auth/verify-email', { method: 'POST', body: { token: `fake-${RUN}` } }),
    401, 'TOKEN_INVALID');

  const meAfter = await call('/api/auth/me', { token: a.accessToken });
  check('me 显示邮箱已验证', meAfter.data?.emailVerified === true);
  const resendAfterVerified = await call('/api/auth/resend-verification', { method: 'POST', token: a.accessToken });
  check('已验证后重发被拒（不是静默成功）', resendAfterVerified.status === 400,
    `HTTP ${resendAfterVerified.status} / ${resendAfterVerified.data?.code}`);

  // 重新登录一次，用一对「干净」的令牌继续后面的用例
  const session1 = await login(userA, passA);
  check('用用户名登录成功', session1.status === 200, `HTTP ${session1.status}`);
  const access1 = session1.data?.accessToken;
  const refresh1 = session1.data?.refreshToken;

  const byEmail = await login(emailA, passA);
  check('用邮箱也能登录同一个账号', byEmail.status === 200 && byEmail.data?.userId === session1.data?.userId);

  // ---------------------------------------------------------------- 2. 防枚举
  section('2. 防用户名枚举');

  const noUser = await login(`ghost_${RUN}`, passA);
  const wrongPass = await login(userA, 'WrongPass123');
  check('用户不存在的错误码与密码错误一致',
    noUser.status === wrongPass.status && noUser.data?.code === wrongPass.data?.code,
    `both ${noUser.status}/${noUser.data?.code}`);
  check('错误文案不暴露账号是否存在',
    noUser.data?.message === '用户名或密码错误', `"${noUser.data?.message}"`);

  // ---------------------------------------------------------------- 3. 锁定
  section('3. 登录失败锁定');

  const lockUser = `lock_${RUN}`;
  await register(lockUser, `${lockUser}@example.com`, passA);
  let lastLock = null;
  for (let i = 1; i <= 5; i += 1) {
    const attempt = await login(lockUser, 'Nope12345');
    if (i < 5) {
      check(`第 ${i} 次失败仍是 401（还剩 ${5 - i} 次）`,
        attempt.status === 401 && /还可尝试/.test(attempt.data?.message ?? ''),
        `"${attempt.data?.message}"`);
    } else {
      lastLock = attempt;
    }
  }
  expectError('第 5 次失败后账号锁定', lastLock, 423, 'ACCOUNT_LOCKED');

  const lockedCorrect = await login(lockUser, passA);
  expectError('锁定期内密码正确也进不去', lockedCorrect, 423, 'ACCOUNT_LOCKED');
  check('锁定提示里给出了等待时长',
    /分钟/.test(lockedCorrect.data?.message ?? ''), `"${lockedCorrect.data?.message}"`);

  // ---------------------------------------------------------------- 4. 双令牌
  section('4. 刷新令牌轮换与重放检测');

  const rotated = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh1 } });
  check('刷新成功换到新令牌', rotated.status === 200 && typeof rotated.data?.accessToken === 'string');
  check('刷新会轮换 refresh（旧的不复用）',
    rotated.data?.refreshToken !== refresh1, '新的 refresh 与旧的不同');
  const access2 = rotated.data?.accessToken;
  const refresh2 = rotated.data?.refreshToken;

  const replay = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh1 } });
  expectError('重放已用过的 refresh 被拒', replay, 401, 'TOKEN_INVALID');

  const afterReplay = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh2 } });
  expectError('重放触发全量吊销（连轮换后的新令牌一起作废）', afterReplay, 401, 'TOKEN_INVALID');

  const newAccessWorks = await call('/api/auth/me', { token: access2 });
  check('access 是无状态 JWT：吊销会话后短期内仍可用（2h 内自然过期）',
    newAccessWorks.status === 200, `HTTP ${newAccessWorks.status}`);

  // 重新登录拿一对新的
  const session2 = await login(userA, passA);
  const accessA = session2.data?.accessToken;
  const refreshA = session2.data?.refreshToken;

  // ---------------------------------------------------------------- 5. 找回密码
  section('5. 找回密码（含防枚举与冷却）');

  const unknown = await call('/api/auth/forgot-password', { method: 'POST', body: { email: `nobody_${RUN}@example.com` } });
  check('未注册邮箱也返回「已发送」（防枚举）',
    unknown.status === 200 && unknown.data?.sent === true && !unknown.data?.devToken);
  check('未注册邮箱会打码', /^\S{1,2}\*\*\*@/.test(unknown.data?.target ?? ''), `"${unknown.data?.target}"`);

  const forgot = await call('/api/auth/forgot-password', { method: 'POST', body: { email: emailA } });
  check('已注册邮箱发出重置邮件', forgot.status === 200 && typeof forgot.data?.devToken === 'string');
  const resetToken = forgot.data?.devToken;

  const cooldown = await call('/api/auth/forgot-password', { method: 'POST', body: { email: emailA } });
  check('冷却期内不重发（但对外的回答不变）',
    cooldown.status === 200 && cooldown.data?.sent === true && cooldown.data?.devToken === null,
    '第二次没有新令牌');

  expectError('垃圾令牌重置被拒',
    await call('/api/auth/reset-password', { method: 'POST', body: { token: `bogus-${RUN}`, password: passA2 } }),
    401, 'TOKEN_INVALID');
  expectError('重置时弱密码被拒',
    await call('/api/auth/reset-password', { method: 'POST', body: { token: resetToken, password: 'short1' } }),
    400, 'VALIDATION_FAILED');

  const reset = await call('/api/auth/reset-password', { method: 'POST', body: { token: resetToken, password: passA2 } });
  check('重置密码成功', reset.status === 200, `HTTP ${reset.status}`);
  check('新密码可以登录', (await login(userA, passA2)).status === 200);
  check('旧密码不再可用', (await login(userA, passA)).status === 401);
  expectError('重置后旧 refresh 一并作废',
    await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refreshA } }), 401, 'TOKEN_INVALID');

  const session3 = await login(userA, passA2);
  const accessB = session3.data?.accessToken;
  const refreshB = session3.data?.refreshToken;

  // ---------------------------------------------------------------- 6. 改密码
  section('6. 登录状态下改密码');

  expectError('原密码错误返回 401 而不是掉线',
    await call('/api/auth/change-password', { method: 'POST', token: accessB, body: { oldPassword: 'NotIt12345', newPassword: passA } }),
    401, 'UNAUTHORIZED');
  check('原密码错后原 access 仍然可用（没有被误判为过期）',
    (await call('/api/auth/me', { token: accessB })).status === 200);
  expectError('新旧密码相同时被拒',
    await call('/api/auth/change-password', { method: 'POST', token: accessB, body: { oldPassword: passA2, newPassword: passA2 } }),
    400, 'VALIDATION_FAILED');

  const deviceTwo = await login(userA, passA2); // 模拟第二台设备
  const changed = await call('/api/auth/change-password', {
    method: 'POST', token: accessB, body: { oldPassword: passA2, newPassword: passA },
  });
  check('改密成功并返回新的令牌对', changed.status === 200 && typeof changed.data?.accessToken === 'string');
  const accessC = changed.data?.accessToken;
  const refreshC = changed.data?.refreshToken;
  check('当前设备换到全新 refresh', refreshC !== refreshB);
  expectError('其他设备被踢下线',
    await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: deviceTwo.data?.refreshToken } }),
    401, 'TOKEN_INVALID');
  const stillAlive = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refreshC } });
  check('已作废令牌被重试不会连坐在用的设备（否则就是个免鉴权的踢人开关）',
    stillAlive.status === 200, `HTTP ${stillAlive.status}`);
  check('当前设备无需重新登录', (await call('/api/auth/me', { token: accessC })).status === 200);

  // ---------------------------------------------------------------- 7. 会话
  section('7. 登录设备管理');

  await login(userA, passA); // 再开一台
  const sessions = await call('/api/auth/sessions', { token: accessC });
  check('能列出有效登录设备', Array.isArray(sessions.data) && sessions.data.length >= 2,
    `${sessions.data?.length} 台`);
  check('设备信息包含可识别的摘要',
    typeof sessions.data?.[0]?.device === 'string' && sessions.data[0].device.length > 0,
    `"${sessions.data?.[0]?.device}"`);
  check('设备列表不含令牌本身',
    !JSON.stringify(sessions.data).includes('accessToken') && !JSON.stringify(sessions.data).includes('refreshToken'));

  const victim = sessions.data.find((session) => session.id !== undefined);
  const revoked = await call(`/api/auth/sessions/${victim.id}`, { method: 'DELETE', token: accessC });
  check('可以注销单台设备', revoked.status === 200, `HTTP ${revoked.status}`);
  const afterRevoke = await call('/api/auth/sessions', { token: accessC });
  check('注销后设备数减少', afterRevoke.data.length === sessions.data.length - 1,
    `${sessions.data.length} → ${afterRevoke.data.length}`);

  // ---------------------------------------------------------------- 8. 积分
  section('8. 积分账户、套餐与订单');

  const summary = await call('/api/credits/summary', { token: accessC });
  check('积分概览可读', summary.status === 200 && typeof summary.data?.balance === 'number');
  check('注册赠送已入账', summary.data?.totalGranted === summary.data?.balance,
    `获得 ${summary.data?.totalGranted} / 余额 ${summary.data?.balance}`);
  check('累计消耗为 0', summary.data?.totalConsumed === 0);
  check('概览带上定价说明', typeof summary.data?.pricingNote === 'string' && summary.data.pricingNote.length > 4,
    `"${summary.data?.pricingNote}"`);

  const ledger0 = await call('/api/credits/ledger?limit=20&offset=0', { token: accessC });
  check('流水里有一笔注册赠送',
    ledger0.data?.items?.some((item) => item.kind === 'SIGNUP_BONUS' && item.delta > 0),
    `${ledger0.data?.total} 条`);
  check('流水带上变动后余额', typeof ledger0.data?.items?.[0]?.balanceAfter === 'number');

  expectError('缺少令牌时重发被拒（该端点需要登录）',
    await call('/api/auth/resend-verification', { method: 'POST' }), 401, 'UNAUTHORIZED');

  const bigPage = await call('/api/credits/ledger?limit=9999', { token: accessC });
  check('分页上限被夹住（limit=9999 最多回 100 条）',
    bigPage.status === 200 && (bigPage.data?.items?.length ?? 0) <= 100,
    `${bigPage.data?.items?.length} 条`);

  const reconciled = await call('/api/credits/reconcile', { token: accessC });
  check('余额与账本累计值一致（对账通过）',
    reconciled.data?.consistent === true,
    `余额 ${reconciled.data?.balance} ｜ 账本 ${reconciled.data?.ledgerSum}`);

  const plans = await call('/api/credits/plans', { token: accessC });
  check('套餐列表非空', Array.isArray(plans.data) && plans.data.length >= 3, `${plans.data?.length} 档`);
  const starter = plans.data.find((plan) => plan.code === 'starter');
  check('套餐由后端算好「总积分」与「每千分单价」',
    starter && starter.totalCredits > 0 && typeof starter.centsPerKiloCredit === 'number',
    starter ? `${starter.name}：${starter.totalCredits} 分 / ${starter.centsPerKiloCredit} 分每元` : 'missing');

  expectError('不存在的套餐下单被拒',
    await call('/api/credits/orders', { method: 'POST', token: accessC, body: { planCode: `nope-${RUN}` } }),
    404, 'NOT_FOUND');

  const order = await call('/api/credits/orders', { method: 'POST', token: accessC, body: { planCode: 'starter' } });
  check('下单成功', order.status === 200 && order.data?.order?.status === 'PENDING', `HTTP ${order.status}`);
  const orderNo = order.data?.order?.orderNo;
  check('下单返回支付参数（payToken）',
    typeof order.data?.payment?.payToken === 'string' && order.data?.payment?.mock === true);
  check('返回体里的订单不含 payToken（凭证只在下单响应里出现）',
    order.data?.order && !('payToken' in order.data.order));

  const beforePay = (await call('/api/credits/summary', { token: accessC })).data.balance;

  const reissued = await call(`/api/credits/orders/${orderNo}/payment`, { method: 'POST', token: accessC });
  check('待支付订单可以重新取支付参数（真实通道会过期）',
    reissued.status === 200 && typeof reissued.data?.payment?.payToken === 'string');
  check('重新取参数会换一份新凭证',
    reissued.data?.payment?.payToken !== order.data?.payment?.payToken);

  const payToken = reissued.data.payment.payToken;
  const paid = await call(`/api/credits/orders/${orderNo}/pay`, { method: 'POST', token: accessC, body: { payToken } });
  check('支付回调成功', paid.status === 200 && paid.data?.status === 'PAID', `HTTP ${paid.status}`);

  const afterFirstPay = (await call('/api/credits/summary', { token: accessC })).data.balance;
  const planCredits = order.data.order.credits;
  check('积分按套餐额度到账', afterFirstPay === beforePay + planCredits,
    `${beforePay} → ${afterFirstPay}（+${planCredits}）`);

  const replayPay = await call(`/api/credits/orders/${orderNo}/pay`, { method: 'POST', token: accessC, body: { payToken } });
  const afterSecondPay = (await call('/api/credits/summary', { token: accessC })).data.balance;
  check('重复回调不重复到账（幂等）',
    replayPay.status === 200 && replayPay.data?.status === 'PAID' && afterSecondPay === afterFirstPay,
    `余额仍为 ${afterSecondPay}`);

  const rechargeLedger = await call('/api/credits/ledger?limit=100', { token: accessC });
  const rechargeCount = rechargeLedger.data.items.filter(
    (item) => item.kind === 'RECHARGE' && item.refId === orderNo,
  ).length;
  check('账本里这笔充值只有一条', rechargeCount === 1, `${rechargeCount} 条`);

  expectError('已支付订单不能再重新取参数',
    await call(`/api/credits/orders/${orderNo}/payment`, { method: 'POST', token: accessC }),
    409, 'ORDER_NOT_PAYABLE');

  const order2 = await call('/api/credits/orders', { method: 'POST', token: accessC, body: { planCode: 'pro' } });
  const orderNo2 = order2.data?.order?.orderNo;
  const cancelled = await call(`/api/credits/orders/${orderNo2}/cancel`, { method: 'POST', token: accessC });
  check('待支付订单可取消', cancelled.status === 200 && cancelled.data?.status === 'CANCELLED');
  expectError('已取消的订单不能支付',
    await call(`/api/credits/orders/${orderNo2}/pay`, { method: 'POST', token: accessC, body: { payToken: 'x' } }),
    409, 'ORDER_NOT_PAYABLE');
  check('取消后余额不变',
    (await call('/api/credits/summary', { token: accessC })).data.balance === afterSecondPay);

  // ---------------------------------------------------------------- 9. 对话计费
  section('9. 对话链路的预扣与结算');

  const workspace = await call('/api/workspaces', {
    method: 'POST', token: accessC, body: { name: `credits-${RUN}`, sample: true },
  });
  check('建好自检工作区', workspace.status === 200 || workspace.status === 201, `HTTP ${workspace.status}`);
  const workspaceId = workspace.data?.id;

  const session = await call('/api/chat/sessions', { method: 'POST', token: accessC, body: { workspaceId } });
  const chatSessionId = session.data?.id;
  check('建好对话会话', typeof chatSessionId === 'number');

  const stream = await openStream(chatSessionId, accessC);
  const balanceBeforeTurn = (await call('/api/credits/summary', { token: accessC })).data.balance;
  const sent = await call(`/api/chat/sessions/${chatSessionId}/messages`, {
    method: 'POST', token: accessC, body: { content: '这个项目的构建方式是什么？', mode: 'deliver' },
  });
  check('发消息被接受（202：立即返回，回答走 SSE）', sent.status === 202, `HTTP ${sent.status}`);

  const done = await stream.waitFor('done', 60000);
  stream.close();
  check('一轮对话正常结束', done !== null, done ? `messageId=${done.messageId}` : '超时未收到 done');

  const messages = await call(`/api/chat/sessions/${chatSessionId}/messages`, { token: accessC });
  const answer = (messages.data ?? []).find((message) => message.role === 'assistant' && message.meta?.credits !== undefined);
  const balanceAfterTurn = (await call('/api/credits/summary', { token: accessC })).data.balance;

  check('回答里带上了本轮扣费', answer && Number(answer.meta.credits) > 0, `${answer?.meta?.credits} 分`);
  check('回答里带上了扣费后余额', Number(answer?.meta?.creditsBalance) === balanceAfterTurn,
    `meta ${answer?.meta?.creditsBalance} ｜ 实际 ${balanceAfterTurn}`);
  check('余额确实减少了', balanceAfterTurn < balanceBeforeTurn,
    `${balanceBeforeTurn} → ${balanceAfterTurn}`);
  check('单轮扣费不低于最低消费（1 分）', Number(answer?.meta?.credits) >= 1, `${answer?.meta?.credits} 分`);

  const turnLedger = await call('/api/credits/ledger?limit=100', { token: accessC });
  const refId = `msg:${sent.data.messageId}`;
  const holdEntry = turnLedger.data.items.find((item) => item.kind === 'HOLD' && item.refId === refId);
  const settleEntry = turnLedger.data.items.find((item) => item.kind === 'SETTLE' && item.refId === refId);
  check('账本里有本轮的预扣（HOLD）', Boolean(holdEntry), holdEntry ? `${holdEntry.delta} 分` : '缺失');
  check('账本里有本轮的结算（SETTLE）', Boolean(settleEntry), settleEntry ? `${settleEntry.delta} 分` : '缺失');
  check('预扣 + 结算 = 实际扣费',
    holdEntry && settleEntry && holdEntry.delta + settleEntry.delta === -Number(answer.meta.credits),
    `${holdEntry?.delta} + ${settleEntry?.delta} = ${(holdEntry?.delta ?? 0) + (settleEntry?.delta ?? 0)}`);

  const turnReconcile = await call('/api/credits/reconcile', { token: accessC });
  check('扣费后账本仍然对得上', turnReconcile.data?.consistent === true,
    `余额 ${turnReconcile.data?.balance} ｜ 账本 ${turnReconcile.data?.ledgerSum}`);

  // ---------------------------------------------------------------- 10. 余额闸门
  section('10. 余额不足与人工调整（管理端）');

  const admin = await ensureAdmin();
  check('引导配置把 e2e_admin 提为管理员',
    admin?.role === 'ADMIN', `role=${admin?.role}`);
  const adminToken = admin?.accessToken;

  const userAId = a.userId;
  const drained = await call('/api/admin/credits/adjust', {
    method: 'POST', token: adminToken,
    body: { userId: userAId, amount: -balanceAfterTurn, reason: 'e2e 自检：清空余额以验证闸门' },
  });
  check('管理员可以人工调整积分', drained.status === 200 && drained.data?.balance === 0,
    `余额 ${drained.data?.balance}`);

  const blocked = await call(`/api/chat/sessions/${chatSessionId}/messages`, {
    method: 'POST', token: accessC, body: { content: '余额为 0 时还能问吗？', mode: 'deliver' },
  });
  expectError('余额不足时对话被拒（402 而不是 403）', blocked, 402, 'INSUFFICIENT_CREDITS');
  check('拒绝文案里给出了当前余额与最低需求',
    /积分不足/.test(blocked.data?.message ?? ''), `"${blocked.data?.message}"`);

  const messagesAfterBlock = await call(`/api/chat/sessions/${chatSessionId}/messages`, { token: accessC });
  check('被拒的请求不会留下一条永远等不到回答的用户消息',
    messagesAfterBlock.data.length === (messages.data?.length ?? 0),
    `${messages.data?.length} → ${messagesAfterBlock.data.length}`);

  const topped = await call('/api/admin/credits/adjust', {
    method: 'POST', token: adminToken,
    body: { userId: userAId, amount: 500, reason: 'e2e 自检：补回余额' },
  });
  check('补回余额成功', topped.data?.balance === 500, `${topped.data?.balance} 分`);

  const adminView = await call(`/api/admin/accounts/${userA}`, { token: adminToken });
  check('管理端能查账号与账本一致性',
    adminView.status === 200 && adminView.data?.consistent === true,
    `余额 ${adminView.data?.balance} ｜ 账本 ${adminView.data?.ledgerSum}`);

  // ---------------------------------------------------------------- 11. 越权
  section('11. 越权与鉴权');

  expectError('非管理员访问管理端被拒',
    await call(`/api/admin/accounts/${userA}`, { token: accessC }), 403, 'FORBIDDEN');
  expectError('非管理员不能给自己加分',
    await call('/api/admin/credits/adjust', {
      method: 'POST', token: accessC, body: { userId: userAId, amount: 99999, reason: 'try' },
    }), 403, 'FORBIDDEN');

  expectError('无令牌访问积分接口被拒', await call('/api/credits/summary'), 401, 'UNAUTHORIZED');
  expectError('伪造令牌被拒',
    await call('/api/credits/summary', { token: 'not.a.real.token' }), 401, 'UNAUTHORIZED');

  const otherUser = await register(userB, `${userB}@example.com`, passA);
  const otherToken = otherUser.data?.accessToken;
  expectError('不能支付别人的订单',
    await call(`/api/credits/orders/${orderNo}/pay`, { method: 'POST', token: otherToken, body: { payToken: 'x' } }),
    404, 'NOT_FOUND');
  const otherOrders = await call('/api/credits/orders', { token: otherToken });
  check('订单列表只包含自己的订单',
    (otherOrders.data ?? []).every((item) => item.orderNo !== orderNo),
    `${otherOrders.data?.length} 条`);

  // ---------------------------------------------------------------- 12. 登出
  section('12. 退出登录');

  const sessionD = await login(userA, passA);
  const out = await call('/api/auth/logout', { method: 'POST', body: { refreshToken: sessionD.data.refreshToken } });
  check('退出登录成功', out.status === 200, `HTTP ${out.status}`);
  expectError('退出后 refresh 立即失效',
    await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: sessionD.data.refreshToken } }),
    401, 'TOKEN_INVALID');
  check('退出不需要带上 access（access 往往已过期）',
    out.status === 200, '仅凭 refresh 即可');

  return finish();
}

function finish() {
  const line = `\n\u001b[1m结果\u001b[0m  \u001b[32m通过 ${pass}\u001b[0m  ${fail > 0 ? `\u001b[31m失败 ${fail}\u001b[0m` : '失败 0'}`;
  emit(line);
  if (REPORT_FILE) {
    writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  bad('脚本异常', String(error && error.stack ? error.stack.split('\n')[0] : error));
  finish();
});
