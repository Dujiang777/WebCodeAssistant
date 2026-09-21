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
};

/** 人读的字节数格式化。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
