/**
 * 与后端交互的薄封装。
 *
 * 五条约定：
 *   1. 双令牌：access（2 小时，随请求发）+ refresh（30 天，只用来换新的 access）；
 *   2. access 过期时**先静默刷新一次再重试**，用户全程无感；刷新失败才登出；
 *   3. 「凭据错」与「令牌过期」都是 401，必须分开 —— 否则输错一次原密码就被当成掉线；
 *   4. 后端错误统一是 { code, message }，这里翻译成 HttpError 抛出，UI 只读 message；
 *   5. 会话变化（登录 / 刷新 / 登出 / 积分变动）经 subscribeSession 广播，
 *      顶栏徽标与各页面不需要层层传 props。
 */

const ACCESS_KEY = 'wca.access';
const REFRESH_KEY = 'wca.refresh';
const ACCESS_EXP_KEY = 'wca.access.exp';
const USER_KEY = 'wca.user';

/**
 * 旧键迁移：`patchforge.*` 是改名前的品牌，`wca.token` 是单令牌时代的 access。
 * 读一次就搬过来，避免老用户升级后被强制登出。
 */
const LEGACY_KEYS: [string, string][] = [
  ['patchforge.token', ACCESS_KEY],
  ['patchforge.user', USER_KEY],
  ['wca.token', ACCESS_KEY],
];

let migrated = false;

function migrateLegacyKeys(): void {
  if (migrated) return;
  migrated = true;
  try {
    for (const [legacy, current] of LEGACY_KEYS) {
      const value = localStorage.getItem(legacy);
      if (value === null) continue;
      if (localStorage.getItem(current) === null) localStorage.setItem(current, value);
      localStorage.removeItem(legacy);
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃，登录流程自己会兜底
  }
}

/** 当前登录用户在本地的最小快照。积分是「会变的状态」，跟着会话一起走。 */
export interface AuthUser {
  userId: number;
  username: string;
  email: string | null;
  emailVerified: boolean;
  role: string;
  credits: number;
  lowBalance: boolean;
  /** 余额闸门是否开启：开启时余额不足会直接拒绝发起对话。 */
  enforceBalance: boolean;
}

/** 注册 / 登录 / 刷新 / 改密的统一返回体。 */
export interface AuthResult {
  userId: number;
  username: string;
  email: string | null;
  emailVerified: boolean;
  role: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
  credits: number;
  lowBalance: boolean;
  /** 仅在邮件通道为 dev 时非空 —— 本地没有真邮箱，靠它把验证链路走通。 */
  devVerifyToken: string | null;
}

/** 当前用户 + 积分概览（`GET /api/auth/me`）。 */
export interface MeInfo {
  userId: number;
  username: string;
  email: string | null;
  emailVerified: boolean;
  role: string;
  credits: number;
  lowBalance: boolean;
  enforceBalance: boolean;
  lowBalanceThreshold: number;
  pricingNote: string;
  mailEchoTokens: boolean;
}

/** 「发一封信」类接口的返回体。 */
export interface Dispatch {
  sent: boolean;
  target: string | null;
  devToken: string | null;
}

/** 一台已登录的设备。刻意不含令牌本身。 */
export interface LoginSession {
  id: number;
  device: string | null;
  ip: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
  }
}

// ------------------------------------------------------------------ 会话存储

type SessionListener = (user: AuthUser | null) => void;

const listeners = new Set<SessionListener>();
/** undefined = 还没读过 localStorage；null = 确定没登录。 */
let cached: AuthUser | null | undefined;

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function loadUser(): AuthUser | null {
  migrateLegacyKeys();
  if (cached === undefined) cached = readStoredUser();
  return cached;
}

export function loadAccessToken(): string | null {
  migrateLegacyKeys();
  return localStorage.getItem(ACCESS_KEY);
}

export function loadRefreshToken(): string | null {
  migrateLegacyKeys();
  return localStorage.getItem(REFRESH_KEY);
}

function emit(user: AuthUser | null): void {
  cached = user;
  for (const listener of [...listeners]) listener(user);
}

/**
 * 订阅登录态。注册时会**立刻回调一次当前值** —— 否则页面首帧会先按「未登录」渲染，
 * 再被下一帧纠正，出现一下登录页的闪烁。
 */
export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  listener(loadUser());
  return () => {
    listeners.delete(listener);
  };
}

/** 认证成功后落盘并广播。返回组装好的用户对象，调用方通常直接拿它设置状态。 */
export function adoptAuth(result: AuthResult): AuthUser {
  const user: AuthUser = {
    userId: result.userId,
    username: result.username,
    email: result.email,
    emailVerified: result.emailVerified,
    role: result.role,
    credits: result.credits,
    lowBalance: result.lowBalance,
    enforceBalance: loadUser()?.enforceBalance ?? true,
  };
  try {
    localStorage.setItem(ACCESS_KEY, result.accessToken);
    localStorage.setItem(REFRESH_KEY, result.refreshToken);
    localStorage.setItem(ACCESS_EXP_KEY, String(Date.now() + result.accessTokenExpiresIn * 1000));
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // 落盘失败不影响本次会话（内存里仍然可用），下次刷新页面需要重新登录
  }
  emit(user);
  return user;
}

/** 补齐 `me` 才知道的字段（闸门开关、支付通道），不碰令牌。 */
export function patchUser(patch: Partial<AuthUser>): AuthUser | null {
  const current = loadUser();
  if (!current) return null;
  const next = { ...current, ...patch };
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(next));
  } catch {
    // 同上
  }
  emit(next);
  return next;
}

/** 对话结算后刷新余额：只改积分，不重发 `/me`。 */
export function updateCredits(credits: number, lowBalance: boolean): void {
  patchUser({ credits, lowBalance });
}

export function clearSession(): void {
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(ACCESS_EXP_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // 忽略：清不掉也会被 emit(null) 覆盖掉内存中的登录态
  }
  emit(null);
}

// ------------------------------------------------------------------ 静默刷新

/**
 * 同一时刻只允许有一个刷新在飞。
 *
 * 首屏常常一次并发好几个请求，access 一旦过期它们会同时收到 401；
 * 没有这个闸门的话会连发多个刷新请求，而 refresh 是**轮换**的 ——
 * 第二个请求拿着已经被换掉的旧令牌，会被后端的重放检测判定为「令牌泄露」，
 * 直接把该用户所有会话全部吊销。这条不是优化，是正确性。
 */
let refreshing: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  const refreshToken = loadRefreshToken();
  if (!refreshToken) return Promise.resolve(null);

  refreshing = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as AuthResult;
      adoptAuth(body);
      return body.accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * 给 SSE 用：拿一个「确定还没过期」的 access。
 *
 * 长会话里连接会重连很多次，直接复用内存里的 access 迟早撞上过期时刻，
 * 表现成「聊到一半事件流就断了」。这里留 60 秒余量提前换新。
 */
export async function ensureAccessToken(): Promise<string | null> {
  const token = loadAccessToken();
  if (!token) return null;
  const expiresAt = Number(localStorage.getItem(ACCESS_EXP_KEY) ?? 0);
  if (expiresAt > 0 && Date.now() > expiresAt - 60_000) {
    return (await refreshAccessToken()) ?? token;
  }
  return token;
}

// ------------------------------------------------------------------ 请求

interface RequestOptions {
  /**
   * 401 时是否尝试静默刷新再重试。
   *
   * 登录 / 注册 / 改密这类接口必须传 false：它们的 401 表示「凭据不对」，
   * 而不是「令牌过期」。不区分的话，用户在设置页输错一次原密码，
   * 就会被当成掉线踢回登录页 —— 这是很典型的“顺手写错”型 bug。
   */
  retryOn401?: boolean;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = loadAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const retryOn401 = options.retryOn401 ?? true;
  let response = await send(path, init);

  if (response.status === 401 && retryOn401) {
    const fresh = await refreshAccessToken();
    if (fresh) response = await send(path, init);
    if (response.status === 401) {
      // 刷新之后还是 401：refresh 也被吊销或过期了，只能回登录页
      clearSession();
      throw new HttpError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
    }
  }
  if (response.status === 204) {
    return undefined as T;
  }
  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      code = body.code ?? code;
      message = body.message ?? message;
    } catch {
      // 后端返回了非 JSON（例如 nginx 502），保留默认文案
    }
    throw new HttpError(response.status, code, message);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ------------------------------------------------------------------ 模型

export interface Workspace {
  id: number;
  name: string;
  gitUrl: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number | null;
  children: FileNode[] | null;
}

export interface FileContent {
  path: string;
  content: string | null;
  sizeBytes: number;
  truncated: boolean;
  binary: boolean;
  language: string;
}

export interface ChatSession {
  id: number;
  workspaceId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface PatchRecord {
  id: string;
  sessionId: number;
  messageId: number | null;
  file: string;
  diff: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  appliedAt: string | null;
}

export interface HealthInfo {
  status: string;
  modelConfigured: boolean;
  model: string | null;
  grepEngine: string;
  redisAvailable: boolean;
}

/** 交付模式：少说话、给结果；教学模式：讲清为什么。 */
export type AgentMode = 'deliver' | 'teach';

/**
 * 回答里的一处引用，由后端在回合结束时校验过。
 *
 * `valid=false` 表示这个路径在工作区里不存在（或行号越界），前端会标红 ——
 * 「编出来的引用」不该看起来和真引用一样。
 */
export interface Citation {
  file: string;
  line: number | null;
  endLine: number | null;
  valid: boolean;
  reason: string | null;
}

export interface RefView {
  file: string;
  line: number;
  text: string;
  kind: string;
}

export interface RiskView {
  label: string;
  level: 'high' | 'medium' | 'low' | string;
  reason: string;
}

/** 补丁影响面（风险条）。 */
export interface BlastRadius {
  file: string;
  declaredType: string | null;
  changedMembers: string[];
  addedLines: number;
  removedLines: number;
  callers: RefView[];
  tests: RefView[];
  risks: RiskView[];
  riskLevel: 'high' | 'medium' | 'low' | string;
  headline: string;
  callersTruncated: boolean;
}

export interface CompileIssue {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  severity: string;
}

/** 编译验证结果。`status` 为 unavailable / disabled 时**不代表**编译通过。 */
export interface BuildResult {
  status: 'ok' | 'failed' | 'timeout' | 'unavailable' | 'disabled' | string;
  buildSystem: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  issues: CompileIssue[];
  note: string;
}

// ------------------------------------------------------------------ 功能 5-8 模型

/** 仓库宪法视图。exists=false 表示工作区里还没有宪法。 */
export interface ConstitutionView {
  exists: boolean;
  path: string | null;
  content: string | null;
  updatedAt: number | null;
  updatedAtIso?: string | null;
}

/** 宪法模板（不落盘）。 */
export interface ConstitutionTemplate {
  content: string;
}

/** Spring 地图：一个 Bean 节点。 */
export interface SpringMapNode {
  name: string;
  stereotype: string;
  layer: string;
  file: string;
  line: number;
  basePath: string | null;
  endpoints: string[];
}

/** Spring 地图：一条构造器注入依赖。 */
export interface SpringMapEdge {
  from: string;
  to: string;
}

/** Spring 地图整体。nodes 为空表示非 Spring 项目（note 里会说明）。 */
export interface SpringMapData {
  workspaceName: string;
  scannedFiles: number;
  nodes: SpringMapNode[];
  edges: SpringMapEdge[];
  truncated: boolean;
  note: string;
}

/** 测试用例统计。skipped 可能为 null（框架未报告）。 */
export interface TestTotals {
  run: number;
  failures: number;
  errors: number;
  skipped: number | null;
}

/** 一个失败用例。 */
export interface TestFailure {
  testClass: string;
  method: string | null;
  line: number | null;
  message: string;
  /** 后端序列化的展示名：类.方法（拿不到方法时退化为类名）。 */
  displayName: string;
}

/** 测试运行结果。status 语义与 BuildResult 一致：没跑 ≠ 通过。 */
export interface TestRunResult {
  status: 'ok' | 'failed' | 'timeout' | 'unavailable' | 'disabled' | string;
  buildSystem: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  totals: TestTotals | null;
  failures: TestFailure[];
  /** 测试代码编译不过时的结构化诊断（failures 为空时看这里）。 */
  issues: CompileIssue[] | null;
  note: string;
}

/** PR 预演的审查清单项。state: ok / warn / bad / info */
export interface PrCheckItem {
  text: string;
  state: 'ok' | 'warn' | 'bad' | 'info' | string;
  detail: string;
}

/** 变更预演 PR：应用前看「假如这是真实 PR，它会怎么被描述、审查者会揪住什么」。 */
export interface PrPreview {
  patchId: string;
  title: string;
  branch: string;
  body: string;
  stats: { files: number; addedLines: number; removedLines: number; callers: number; testFiles: number };
  checklist: PrCheckItem[];
}

/** 工作区快照（zip 存服务端，这里是元数据）。 */
export interface SnapshotView {
  id: string;
  kind: 'auto' | 'manual';
  label: string | null;
  patchId: string | null;
  fileCount: number;
  sizeBytes: number;
  createdAt: string;
}

/** 批量应用补丁的逐补丁明细。item.status: applied=成功；pending=失败（附 error）。 */
export interface BatchApplyResult {
  total: number;
  applied: number;
  failed: number;
  items: { patchId: string; file: string; status: string; error: string | null }[];
}

/** 语义检索状态。 */
export interface SemanticStatus {
  available: boolean;
  chunks: number;
}

/** 语义检索单条命中。 */
export interface SemanticHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/** 语义检索响应。status: ok / not_indexed / unavailable */
export interface SemanticResult {
  status: string;
  note: string;
  chunkCount: number;
  hits: SemanticHit[];
}

/** 终端命令执行结果。 */
export interface TerminalResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

// ------------------------------------------------------------------ 接口

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  // ---------------------------------------------------------------- 账号

  register: (username: string, email: string, password: string) =>
    request<AuthResult>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ username, email, password }) },
      { retryOn401: false },
    ),

  /** `identifier` 一个框同时收用户名和邮箱 —— 用户不该被迫记住自己当初填的是哪个。 */
  login: (identifier: string, password: string) =>
    request<AuthResult>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ username: identifier, password }) },
      { retryOn401: false },
    ),

  /** 显式刷新。一般不用手动调：request 内部遇到 401 会自动走一遍。 */
  refresh: (refreshToken: string) =>
    request<AuthResult>(
      '/api/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      { retryOn401: false },
    ),

  logout: (refreshToken: string) =>
    request<Dispatch>(
      '/api/auth/logout',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      { retryOn401: false },
    ),

  me: () => request<MeInfo>('/api/auth/me'),

  verifyEmail: (token: string) =>
    request<Dispatch>(
      '/api/auth/verify-email',
      { method: 'POST', body: JSON.stringify({ token }) },
      { retryOn401: false },
    ),

  resendVerification: () => request<Dispatch>('/api/auth/resend-verification', { method: 'POST' }),

  /** 无论邮箱是否存在都会返回 sent=true（防账号枚举），页面文案必须体现这一点。 */
  forgotPassword: (email: string) =>
    request<Dispatch>(
      '/api/auth/forgot-password',
      { method: 'POST', body: JSON.stringify({ email }) },
      { retryOn401: false },
    ),

  resetPassword: (token: string, password: string) =>
    request<Dispatch>(
      '/api/auth/reset-password',
      { method: 'POST', body: JSON.stringify({ token, password }) },
      { retryOn401: false },
    ),

  /** 改密返回新的一对令牌：其他设备被踢掉，当前设备继续用。 */
  changePassword: (oldPassword: string, newPassword: string) =>
    request<AuthResult>(
      '/api/auth/change-password',
      { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) },
      { retryOn401: false },
    ),

  loginSessions: () => request<LoginSession[]>('/api/auth/sessions'),

  revokeSession: (id: number) =>
    request<Dispatch>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),

  // ---------------------------------------------------------------- 积分

  creditSummary: () => request<CreditSummary>('/api/credits/summary'),

  creditLedger: (limit = 20, offset = 0) =>
    request<LedgerPage>(`/api/credits/ledger?limit=${limit}&offset=${offset}`),

  creditPlans: () => request<CreditPlan[]>('/api/credits/plans'),

  creditOrders: (limit = 20) => request<CreditOrder[]>(`/api/credits/orders?limit=${limit}`),

  /** 下单。返回体里带支付参数（模拟通道是一次性 payToken）。 */
  createOrder: (planCode: string) =>
    request<OrderResponse>('/api/credits/orders', {
      method: 'POST',
      body: JSON.stringify({ planCode }),
    }),

  /**
   * 给一张待支付订单重新取支付参数。
   *
   * 用户关掉收银台再回来时必须走这里，而不是复用上次的 payToken ——
   * 真实通道的预支付会话会过期，旧凭证再用一定是失败的。
   */
  reissuePayment: (orderNo: string) =>
    request<OrderResponse>(`/api/credits/orders/${encodeURIComponent(orderNo)}/payment`, {
      method: 'POST',
    }),

  /** 支付回调。可以重复调用，第二次起不会有任何副作用（幂等）。 */
  payOrder: (orderNo: string, payToken: string) =>
    request<CreditOrder>(`/api/credits/orders/${encodeURIComponent(orderNo)}/pay`, {
      method: 'POST',
      body: JSON.stringify({ payToken }),
    }),

  cancelOrder: (orderNo: string) =>
    request<CreditOrder>(`/api/credits/orders/${encodeURIComponent(orderNo)}/cancel`, {
      method: 'POST',
    }),

  /** 自查对账：余额与账本累计值是否一致。 */
  reconcileCredits: () => request<ReconcileResult>('/api/credits/reconcile'),

  listWorkspaces: () => request<Workspace[]>('/api/workspaces'),

  workspace: (workspaceId: number) => request<Workspace>(`/api/workspaces/${workspaceId}`),

  createWorkspaceFromGit: (name: string, gitUrl: string) =>
    request<Workspace>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, gitUrl }),
    }),

  createSampleWorkspace: (name?: string) =>
    request<Workspace>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: name ?? 'demo-java', sample: true }),
    }),

  createWorkspaceFromZip: (file: File, name?: string) => {
    const form = new FormData();
    form.append('file', file);
    const query = name ? `?name=${encodeURIComponent(name)}` : '';
    return request<Workspace>(`/api/workspaces${query}`, { method: 'POST', body: form });
  },

  tree: (workspaceId: number) => request<FileNode>(`/api/workspaces/${workspaceId}/tree`),

  readFile: (workspaceId: number, path: string) =>
    request<FileContent>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),

  saveFile: (workspaceId: number, path: string, content: string) =>
    request<FileContent>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  createEntry: (workspaceId: number, path: string, type: 'file' | 'dir') =>
    request<Workspace>(`/api/workspaces/${workspaceId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ path, type }),
    }),

  deleteEntry: (workspaceId: number, path: string) =>
    request<void>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  createSession: (workspaceId: number) =>
    request<ChatSession>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),

  listSessions: (workspaceId: number) =>
    request<ChatSession[]>(`/api/chat/sessions?workspaceId=${workspaceId}`),

  listMessages: (sessionId: number) => request<ChatMessage[]>(`/api/chat/sessions/${sessionId}/messages`),

  listPatches: (sessionId: number) => request<PatchRecord[]>(`/api/chat/sessions/${sessionId}/patches`),

  sendMessage: (
    sessionId: number,
    payload: {
      content: string;
      currentFile?: string | null;
      selection?: { startLine: number; endLine: number; text: string } | null;
      mode?: AgentMode;
    },
  ) =>
    request<{ messageId: number; sessionId: number }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * 应用补丁。改动代码行为的补丁必须先看过「开关关闭时的旧路径」并确认
   * （acknowledgeFlag=true），否则后端返回 FLAG_ACK_REQUIRED。
   */
  applyPatch: (patchId: string, acknowledgeFlag = false) =>
    request<PatchRecord>(`/api/patches/${patchId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ acknowledgeFlag }),
    }),

  rejectPatch: (patchId: string) =>
    request<PatchRecord>(`/api/patches/${patchId}/reject`, { method: 'POST' }),

  /** 补丁影响面：改了哪些类、谁在调用、命中哪些风险包、有没有测试。 */
  blastRadius: (patchId: string) => request<BlastRadius>(`/api/patches/${patchId}/blast-radius`),

  /** 应用后在沙箱里跑一次编译。没应用过的补丁会返回 disabled。 */
  compilePatch: (patchId: string) =>
    request<BuildResult>(`/api/patches/${patchId}/compile`, { method: 'POST' }),

  // -------------------------------------------------- 功能 5-8 接口

  /** 读取仓库宪法。exists=false 表示未配置。 */
  constitution: (workspaceId: number) =>
    request<ConstitutionView>(`/api/workspaces/${workspaceId}/constitution`),

  /** 保存仓库宪法（内容写进 .wca/CONSTITUTION.md，Agent 不可修改）。 */
  saveConstitution: (workspaceId: number, content: string) =>
    request<ConstitutionView>(`/api/workspaces/${workspaceId}/constitution`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  /** 宪法模板（只返回文本，不落盘）。 */
  constitutionTemplate: (workspaceId: number) =>
    request<ConstitutionTemplate>(`/api/workspaces/${workspaceId}/constitution/template`),

  /** Spring 组件地图（每次全量重扫，毫秒级）。 */
  springMap: (workspaceId: number) =>
    request<SpringMapData>(`/api/workspaces/${workspaceId}/spring-map`),

  /** 在工作区里跑一次测试套件。 */
  runTests: (workspaceId: number) =>
    request<TestRunResult>(`/api/workspaces/${workspaceId}/test-run`, { method: 'POST' }),

  /** 变更预演 PR（纯只读，待确认 / 已应用的补丁都能看）。 */
  prPreview: (patchId: string) => request<PrPreview>(`/api/patches/${patchId}/pr-preview`),

  /** 快照列表（自动 + 手动）。 */
  snapshots: (workspaceId: number) =>
    request<SnapshotView[]>(`/api/workspaces/${workspaceId}/snapshots`),

  /** 手动打快照，可附说明。 */
  createSnapshot: (workspaceId: number, label: string) =>
    request<SnapshotView>(`/api/workspaces/${workspaceId}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  /** 回滚到快照（真·时点恢复：删掉快照之外的文件再解包）。 */
  restoreSnapshot: (workspaceId: number, snapshotId: string) =>
    request<SnapshotView>(`/api/workspaces/${workspaceId}/snapshots/${snapshotId}/restore`, {
      method: 'POST',
    }),

  /** 删除快照。 */
  deleteSnapshot: (workspaceId: number, snapshotId: string) =>
    request<void>(`/api/workspaces/${workspaceId}/snapshots/${snapshotId}`, { method: 'DELETE' }),

  /**
   * 批量应用会话内全部待确认补丁（整批一次快照，逐补丁返回成败）。
   * 批里若含「行为变化」的补丁，必须带 acknowledgeFlag=true，否则这些会被逐个挡下。
   */
  applyAllPatches: (sessionId: number, acknowledgeFlag = false) =>
    request<BatchApplyResult>(`/api/chat/sessions/${sessionId}/patches/apply-all`, {
      method: 'POST',
      body: JSON.stringify({ acknowledgeFlag }),
    }),

  /** 语义检索状态（是否可用 / 已索引块数）。 */
  semanticStatus: (workspaceId: number) =>
    request<SemanticStatus>(`/api/workspaces/${workspaceId}/semantic/status`),

  /** 全量重建语义索引（工作区规模下秒级）。 */
  reindexSemantic: (workspaceId: number) =>
    request<{ chunks: number }>(`/api/workspaces/${workspaceId}/semantic/index`, {
      method: 'POST',
    }),

  /** 语义检索：自然语言找代码。 */
  semanticSearch: (workspaceId: number, query: string, topK = 8) =>
    request<SemanticResult>(`/api/workspaces/${workspaceId}/semantic/search`, {
      method: 'POST',
      body: JSON.stringify({ query, topK }),
    }),

  /** 终端：在工作区根执行一条命令（仅限登录用户手动触发；模型无此能力）。 */
  runTerminal: (workspaceId: number, command: string) =>
    request<TerminalResult>(`/api/workspaces/${workspaceId}/terminal/run`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  // -------------------------------------------------- 功能 13-16 接口

  /** Agent 工位现状（只读）。平时走 SSE 的 desk 事件，这里用于首屏与断线兜底。 */
  desk: (workspaceId: number, sessionId: number) =>
    request<DeskView>(`/api/workspaces/${workspaceId}/desk?sessionId=${sessionId}`),

  /** 本会话正在等待人工放行的闸门（刷新页面后恢复卡片）。 */
  gates: (sessionId: number) => request<PendingGate[]>(`/api/chat/sessions/${sessionId}/gates`),

  /** 放行一次被拦下的工具调用；可带改过的参数（只覆盖工具原有键）。 */
  approveGate: (sessionId: number, gateId: string, args?: Record<string, unknown>, note?: string) =>
    request<PendingGate>(`/api/chat/sessions/${sessionId}/gates/${encodeURIComponent(gateId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ args: args ?? null, note: note ?? null }),
    }),

  /** 拦下这次工具调用（模型会收到「已被人拦下」，改用只读手段继续）。 */
  rejectGate: (sessionId: number, gateId: string, note?: string) =>
    request<PendingGate>(`/api/chat/sessions/${sessionId}/gates/${encodeURIComponent(gateId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: note ?? null }),
    }),

  /** 读取本会话的闸门策略：off 全放行 / writes 拦写操作 / strict 再拦大范围检索。 */
  gatePolicy: (sessionId: number) =>
    request<{ policy: GatePolicy }>(`/api/chat/sessions/${sessionId}/gate-policy`),

  /** 切换闸门策略。 */
  setGatePolicy: (sessionId: number, policy: GatePolicy) =>
    request<{ policy: GatePolicy }>(`/api/chat/sessions/${sessionId}/gate-policy`, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    }),

  /** 本工作区里的全部平行宇宙（反事实分支）。 */
  whatIfList: (workspaceId: number) =>
    request<WhatIfBranch[]>(`/api/workspaces/${workspaceId}/whatif`),

  /** 开一次 What-if：拷影子、让模型把设想写成 diff、返回左右对照。 */
  whatIfAsk: (workspaceId: number, sessionId: number, question: string, file: string) =>
    request<WhatIfBranch>(`/api/workspaces/${workspaceId}/whatif`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, question, file }),
    }),

  /** 查一次实验的当前状态（ready / adopted / discarded / unavailable）。 */
  whatIfGet: (workspaceId: number, branchId: string) =>
    request<WhatIfBranch>(`/api/workspaces/${workspaceId}/whatif/${encodeURIComponent(branchId)}`),

  /** 丢弃平行宇宙（默认结局，影子目录一并删除）。 */
  whatIfDiscard: (workspaceId: number, branchId: string) =>
    request<WhatIfBranch>(`/api/workspaces/${workspaceId}/whatif/${encodeURIComponent(branchId)}/discard`, {
      method: 'POST',
    }),

  /** 采纳：平行宇宙的改法转成主线上的待确认补丁（仍需人工审阅后才能应用）。 */
  whatIfAdopt: (workspaceId: number, branchId: string) =>
    request<WhatIfAdoptResult>(
      `/api/workspaces/${workspaceId}/whatif/${encodeURIComponent(branchId)}/adopt`,
      { method: 'POST' },
    ),

  /**
   * 补丁的特性开关语义（功能 16）。required=false 时也返回完整视图，
   * 前端展示「为什么不需要开关」，而不是空着。
   */
  featureFlag: (patchId: string) => request<FlagView>(`/api/patches/${patchId}/feature-flag`),
};

// ------------------------------------------------------------------ 功能 13-16 模型

/** 工位阶段：idle 表示空闲，其余为正在跑的工具名。 */
export type DeskPhase = 'idle' | 'read_file' | 'list_dir' | 'grep' | 'propose_patch' | 'run_tests'
  | 'spring_map' | 'semantic_search' | string;

export interface DeskOpenFile {
  path: string;
  /** read（只读打开）/ write（准备写入）。 */
  mode: string;
  lines: number | null;
  at: string;
}

export interface DeskGrep {
  pattern: string;
  scope: string;
  glob: string | null;
  /** running / done / failed */
  state: string;
  hits: number | null;
  at: string;
}

export interface DeskDraft {
  patchId: string;
  file: string;
  added: number;
  removed: number;
  status: string;
  at: string;
}

export interface DeskActivity {
  tool: string;
  label: string;
  /** running / ok / failed */
  status: string;
  summary: string;
  at: string;
}

/** Agent 工位快照。整块状态一次给全，前端只做替换渲染。 */
export interface DeskView {
  sessionId: number;
  phase: DeskPhase;
  phaseLabel: string;
  activeTool: string | null;
  activeIntent: string | null;
  cursorFile: string | null;
  cursorLine: number | null;
  openFiles: DeskOpenFile[];
  grep: DeskGrep | null;
  drafts: DeskDraft[];
  timeline: DeskActivity[];
  toolCalls: number;
  lastDirectory: string | null;
  updatedAt: string;
}

export type GatePolicy = 'off' | 'writes' | 'strict';

/** 一个等待人工放行的工具调用。 */
export interface PendingGate {
  gateId: string;
  sessionId: number;
  tool: string;
  /** 人话版「它想干什么」——闸门卡片最上面那行。 */
  intent: string;
  reason: string;
  args: Record<string, unknown>;
  createdAt: string;
  /** 超时时刻（epoch 毫秒），到点自动放行。 */
  expiresAt: number;
}

/** 反事实分支状态：ready / adopted / discarded / unavailable。 */
export interface WhatIfBranch {
  id: string;
  workspaceId: number;
  question: string;
  file: string;
  status: string;
  note: string | null;
  mainText: string;
  shadowText: string;
  diff: string;
  added: number;
  removed: number;
  createdAt: string;
}

export interface WhatIfAdoptResult {
  patchId: string;
  file: string;
  note: string;
}

/** 补丁的特性开关视图。 */
export interface FlagView {
  patchId: string;
  file: string;
  required: boolean;
  reason: string;
  flagKey: string | null;
  defaultValue: string | null;
  mode: string | null;
  targetMethod: string | null;
  legacyCode: string | null;
  wrappedSnippet: string | null;
  configLine: string | null;
  openRunbook: string | null;
  closedRunbook: string | null;
  addedLines: string[];
  removedLines: string[];
  notice: string;
}

// ------------------------------------------------------------------ 积分模型

/** 积分概览。`holdCredits` 是每轮对话的预扣额度，`pricingNote` 是人话定价说明。 */
export interface CreditSummary {
  balance: number;
  totalGranted: number;
  totalConsumed: number;
  lowBalance: boolean;
  enforceBalance: boolean;
  lowBalanceThreshold: number;
  holdCredits: number;
  signupBonus: number;
  pricingNote: string;
}

/** 一条流水。`delta` 正数入账、负数出账；`balanceAfter` 是这一笔之后的余额。 */
export interface LedgerEntry {
  id: number;
  kind: string;
  delta: number;
  balanceAfter: number;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string | null;
}

export interface LedgerPage {
  items: LedgerEntry[];
  total: number;
}

/**
 * 套餐。`totalCredits` 与 `centsPerKiloCredit` 都由后端算好 —— 让前端自己算
 * 「每千分多少钱」是典型的把业务规则复制到两个地方。
 */
export interface CreditPlan {
  code: string;
  name: string;
  priceCents: number;
  credits: number;
  bonusCredits: number;
  totalCredits: number;
  centsPerKiloCredit: number;
  tag: string | null;
  description: string | null;
}

export type OrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | string;

export interface CreditOrder {
  orderNo: string;
  planCode: string;
  amountCents: number;
  credits: number;
  status: OrderStatus;
  provider: string;
  createdAt: string | null;
  paidAt: string | null;
}

export interface OrderResponse {
  order: CreditOrder;
  /** 支付参数。模拟通道含 payToken / mock / hint；真实通道是二维码内容或跳转 URL。 */
  payment: Record<string, unknown>;
}

export interface ReconcileResult {
  balance: number;
  ledgerSum: number;
  consistent: boolean;
}

/** 流水种类 → 中文 + 语义方向。未知 kind 兜底显示原值，不吞掉。 */
export const LEDGER_KINDS: Record<string, { label: string; tone: 'in' | 'out' | 'hold' }> = {
  SIGNUP_BONUS: { label: '注册赠送', tone: 'in' },
  RECHARGE: { label: '充值到账', tone: 'in' },
  ADJUST: { label: '人工调整', tone: 'in' },
  HOLD: { label: '对话预扣', tone: 'hold' },
  SETTLE: { label: '按用量结算', tone: 'out' },
  RELEASE: { label: '失败退回', tone: 'in' },
};

/** 分 → ¥。整数分不做浮点运算，避免 0.1+0.2 那类误差。 */
export function formatYuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 带符号的积分数字，用于流水表。 */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * ISO 时间 → 本地时间显示。
 *
 * 后端统一返回 `Instant`（UTC，带 Z）。**不能直接对字符串做 slice**：
 * 那样在 +08:00 的时区里会把「15:01 的扣费」显示成「07:01」，
 * 用户看到的每一笔时间都差 8 小时 —— 而这种偏差最容易被当成「账本错乱」。
 * 必须交给 `Date` 做时区换算。
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 人读的字节数格式化。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
