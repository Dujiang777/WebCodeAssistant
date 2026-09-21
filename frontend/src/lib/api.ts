/**
 * 与后端交互的薄封装。
 *
 * 三条约定：
 *   1. 所有请求都带上 Bearer token，token 只存在内存 + localStorage，不进 URL；
 *   2. 后端错误统一是 { code, message }，这里翻译成 HttpError 抛出，UI 只需读 message；
 *   3. 401 统一触发登出，避免每个调用点各写一遍。
 */

const TOKEN_KEY = 'wca.token';
const USER_KEY = 'wca.user';

// 旧品牌（patchforge.*）时代的本地存储键。读一次做迁移，避免老用户升级后被强制登出。
const LEGACY_TOKEN_KEY = 'patchforge.token';
const LEGACY_USER_KEY = 'patchforge.user';

function migrateLegacyKeys(): void {
  try {
    if (localStorage.getItem(TOKEN_KEY) === null && localStorage.getItem(LEGACY_TOKEN_KEY) !== null) {
      const token = localStorage.getItem(LEGACY_TOKEN_KEY);
      const user = localStorage.getItem(LEGACY_USER_KEY);
      if (token !== null) localStorage.setItem(TOKEN_KEY, token);
      if (user !== null) localStorage.setItem(USER_KEY, user);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(LEGACY_USER_KEY);
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃，登录流程自己会兜底
  }
}

export interface AuthUser {
  userId: number;
  username: string;
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

export function loadToken(): string | null {
  migrateLegacyKeys();
  return localStorage.getItem(TOKEN_KEY);
}

export function loadUser(): AuthUser | null {
  migrateLegacyKeys();
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = loadToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });

  if (response.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new HttpError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
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

// ------------------------------------------------------------------ 接口

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  register: (username: string, password: string) =>
    request<{ userId: number; username: string; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  login: (username: string, password: string) =>
    request<{ userId: number; username: string; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: () => request<AuthUser>('/api/auth/me'),

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

  applyPatch: (patchId: string) =>
    request<PatchRecord>(`/api/patches/${patchId}/apply`, { method: 'POST' }),

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
};

/** 人读的字节数格式化。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
