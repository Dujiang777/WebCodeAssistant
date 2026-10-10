/**
 * 对话相关的 UI 模型。
 *
 * 「一轮对话」（turn）在前端是一个显式概念：它跨越多个 SSE 事件，
 * 期间同时存在流式文本、正在跑的工具、已生成的补丁。
 * 把它建模成一个对象而不是散落的 useState，是为了让「回合结束」这件事
 * 只有一个落点（否则很容易出现「补丁卡片不知道挂在哪条消息上」这类问题）。
 */

import { HttpError } from './api';
import type { AgentMode, Citation } from './api';

/** 编辑器选区，会作为上下文注入本轮对话。 */
export interface Selection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ToolItem {
  /** 只用于 React key，与后端的任何 id 无关。 */
  id: number;
  name: string;
  args: unknown;
  status: 'running' | 'done' | 'failed';
  summary: string;
  /** tool_call 到达的本地时间戳；running 状态的卡片用它显示已执行秒数。 */
  startedAt: number;
}

export interface LiveTurn {
  text: string;
  tools: ToolItem[];
  patchIds: string[];
  /** 模型动工前给出的执行计划（set_plan），整体替换语义。 */
  plan: string[];
  /** 回合结束时由后端校验过的引用，用于把编造的引用标红。 */
  citations: Citation[];
  error: string | null;
  /** 用户点了停止：后续增量一律忽略，工具卡片标「已停止」。 */
  stopped?: boolean;
  /** 本轮在前端挂上的本地时间，用来显示已用时。 */
  startedAt?: number;
}

export const EMPTY_TURN: LiveTurn = {
  text: '',
  tools: [],
  patchIds: [],
  plan: [],
  citations: [],
  error: null,
};

export function beginTurn(): LiveTurn {
  return { ...EMPTY_TURN, startedAt: Date.now() };
}

export interface TurnStage {
  key: 'connect' | 'wait' | 'tool' | 'write' | 'gate' | 'stop';
  label: string;
  detail: string;
}

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}

/** 进行中的回合该显示哪一句人话：禁止只写「正在思考」。 */
export function describeTurnStage(
  turn: LiveTurn,
  streamStatus: 'connecting' | 'open' | 'reconnecting' | 'closed',
  sending: boolean,
  gateCount: number,
): TurnStage {
  if (turn.stopped) return { key: 'stop', label: '已停止', detail: '半截回答会保留' };
  if (streamStatus === 'connecting') return { key: 'connect', label: '正在连接事件流…', detail: '' };
  if (streamStatus === 'reconnecting') {
    return { key: 'connect', label: '事件流断开，正在重连…', detail: '会补齐断线期间的事件' };
  }
  if (streamStatus === 'closed' && sending) {
    return { key: 'connect', label: '事件流未连接', detail: '正在重试' };
  }
  if (gateCount > 0) return { key: 'gate', label: '等你放行工具', detail: `${gateCount} 步被拦下` };
  const running = [...turn.tools].reverse().find((tool) => tool.status === 'running');
  if (running) {
    return {
      key: 'tool',
      label: `正在${toolLabel(running.name)}`,
      detail: summarizeToolArgs(running.name, running.args),
    };
  }
  if (turn.text) return { key: 'write', label: '正在写回答…', detail: '' };
  return { key: 'wait', label: '已发送，正在等模型首字…', detail: '不是卡住，模型常会先读文件再开口' };
}

let toolSeq = 0;

export function nextToolId(): number {
  toolSeq += 1;
  return toolSeq;
}

/** 两种工作模式的文案与说明。 */
export const MODE_META: Record<AgentMode, { label: string; hint: string }> = {
  deliver: {
    label: '交付',
    hint: '少说话、直接给补丁和提交说明。适合你自己已经清楚要改什么的时候。',
  },
  teach: {
    label: '教学',
    hint: '解释每次读文件的动机、改法的取舍与风险。适合看别人代码或带新人时。',
  },
};

/** 工具名 → 中文动作，让「模型在干什么」一眼可读。 */
export const TOOL_LABELS: Record<string, string> = {
  set_plan: '制定计划',
  list_dir: '列出目录',
  read_file: '读取文件',
  grep: '搜索代码',
  propose_patch: '生成补丁',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** 工具参数里能打开的文件路径；目录 / 纯模式串不返回。 */
export function toolPathOf(name: string, args: unknown): string | null {
  const record = (args ?? {}) as Record<string, unknown>;
  const raw =
    typeof record.path === 'string' && record.path.length > 0
      ? record.path
      : typeof record.file === 'string' && record.file.length > 0
        ? record.file
        : '';
  if (!raw || raw === '.' || raw === '/') return null;
  if (!/\.[A-Za-z0-9]{1,12}$/.test(raw)) return null;
  return raw;
}

/** 把工具入参压成一行，用于卡片头部的副标题。 */
export function summarizeToolArgs(name: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : '';
  };
  switch (name) {
    case 'set_plan': {
      const steps = record.steps;
      return Array.isArray(steps) ? `${steps.length} 步计划` : '—';
    }
    case 'read_file':
      return pick('path') || '—';
    case 'list_dir':
      return pick('path') || '.';
    case 'grep': {
      const pattern = pick('pattern');
      const glob = pick('glob');
      const scope = pick('path') || '.';
      return `${pattern}  ·  ${scope}${glob ? `  ·  ${glob}` : ''}`;
    }
    case 'propose_patch':
      return pick('file') || '—';
    default: {
      const json = JSON.stringify(args ?? {});
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    }
  }
}

export interface ToolArgPeek {
  key: string;
  value: string;
}

/**
 * 工具参数铭牌（批35）：给工具卡 hover 用的一行「键 值」摘要。
 *
 * 规则：
 *   - 只取标量（string/number/boolean），数组与对象不进铭牌 —— 它们属于点击展开的 JSON；
 *   - 键名按工具语义排序：先 path/file 这类「定位参数」，再 pattern/query 这类「内容参数」，
 *     这样 hover 出来第一行永远是用户最想确认的那个（读了哪个文件、搜了什么）；
 *   - 单值超长截断（长 diff / 长代码进铭牌没有意义）。
 */
export function toolArgsPeek(args: unknown): ToolArgPeek[] {
  const record = (args ?? {}) as Record<string, unknown>;
  const rank = (key: string): number => {
    if (key === 'path' || key === 'file') return 0;
    if (key === 'pattern' || key === 'query' || key === 'glob') return 1;
    if (key === 'summary' || key === 'mode' || key === 'name') return 2;
    return 3;
  };

  const out: ToolArgPeek[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (out.length >= 2) break;
    if (typeof value === 'string') {
      if (value.length === 0) continue;
      out.push({ key, value: value.length > 28 ? `${value.slice(0, 28)}…` : value });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: String(value) });
    }
  }
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}

export function messageOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '未知错误';
}

export function streamLabel(status: 'connecting' | 'open' | 'reconnecting' | 'closed'): string {
  switch (status) {
    case 'connecting':
      return '连接中';
    case 'open':
      return '已连接';
    case 'reconnecting':
      return '重连中';
    default:
      return '未连接';
  }
}

export function streamDotClass(status: 'connecting' | 'open' | 'reconnecting' | 'closed'): string {
  switch (status) {
    case 'open':
      return 'dot dot-ok';
    case 'reconnecting':
    case 'connecting':
      return 'dot dot-warn';
    default:
      return 'dot dot-idle';
  }
}
