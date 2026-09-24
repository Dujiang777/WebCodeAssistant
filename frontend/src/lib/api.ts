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

/** 人读的字节数格式化。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
