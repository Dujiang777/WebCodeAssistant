import { useEffect, useMemo, useRef, useState } from 'react';

import { api, ensureAccessToken, HttpError, updateCredits } from '../lib/api';
import type {
  AgentMode,
  BlastRadius,
  BuildResult,
  ChatMessage,
  ChatSession,
  ConstitutionView,
  CreditSummary,
  DeskView,
  FileContent,
  FileNode,
  FlagView,
  GatePolicy,
  HealthInfo,
  PatchRecord,
  PendingGate,
  TestRunResult,
  Workspace,
} from '../lib/api';
import { EMPTY_TURN, messageOf, nextToolId } from '../lib/chat';
import type { LiveTurn, Selection, ToolItem } from '../lib/chat';
import { navigate } from '../lib/router';
import { openChatStream } from '../lib/sse';
import type { ChatEvent, StreamStatus } from '../lib/sse';
import { useToast } from '../lib/toast';
import { ChatPane } from '../components/ChatPane';
import { AgentDesk } from '../components/AgentDesk';
import { ConstitutionModal } from '../components/ConstitutionModal';
import { EditorPane } from '../components/EditorPane';
import type { RevealTarget } from '../components/EditorPane';
import { FileTree } from '../components/FileTree';
import type { CreateTarget } from '../components/FileTree';
import { PatchModal } from '../components/PatchModal';
import { Splitter } from '../components/Splitter';
import { SpringMapModal } from '../components/SpringMapModal';
import { StatusBar } from '../components/StatusBar';
import { TestsModal } from '../components/TestsModal';
import { SnapshotsModal } from '../components/SnapshotsModal';
import { SemanticModal } from '../components/SemanticModal';
import { TerminalModal } from '../components/TerminalModal';
import { ToolRail } from '../components/ToolRail';
import { TopBar } from '../components/TopBar';
import { WhatIfPanel } from '../components/WhatIfPanel';
import { TerminalMark, FolderIcon, PlusIcon, RefreshIcon } from '../components/icons';

/**
 * IDE 主页面：把「文件 + 编辑器 + 对话」三块拼起来，并持有它们共享的状态。
 *
 * 状态划分的依据是「谁能改变它」：
 *   - 文件类状态由用户操作与补丁应用驱动；
 *   - 对话类状态由 SSE 事件流驱动；
 *   - 二者唯一的交点是「补丁应用成功 → 重新读盘 → 文件区刷新」，这一处显式写在 applyPatch 里。
 *
 * 关于事件流的两个细节：
 *   1. SSE 连接只在 sessionId 变化时重建，回调通过 ref 读最新闭包，避免每次渲染重连；
 *   2. 一轮对话结束时，以服务端落库的消息为准重取一次 —— 断线漏掉的事件在重连时
 *      由 afterId 回放，因此本地拼出来的内容与服务端总是一致。
 */
const LAYOUT_KEY = 'wca.layout';
const MODE_KEY = 'wca.mode';
const DEFAULT_LAYOUT = { left: 252, right: 404, desk: 306 };

interface Layout {
  left: number;
  right: number;
  /** Agent 工位面板宽度（功能 13）。 */
  desk: number;
}

/** 影响面的加载状态：补丁一出现就去算，算完之前卡片上显示「正在分析…」。 */
interface RadiusEntry {
  loading: boolean;
  error: string | null;
  data: BlastRadius | null;
}

/** 特性开关分析的加载状态（功能 16），与影响面同构：补丁一出现就去算。 */
interface FlagEntry {
  loading: boolean;
  error: string | null;
  data: FlagView | null;
}

function loadMode(): AgentMode {
  return localStorage.getItem(MODE_KEY) === 'teach' ? 'teach' : 'deliver';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      left: clamp(Number(parsed.left ?? DEFAULT_LAYOUT.left), 150, 560),
      right: clamp(Number(parsed.right ?? DEFAULT_LAYOUT.right), 280, 780),
      desk: clamp(Number(parsed.desk ?? DEFAULT_LAYOUT.desk), 232, 560),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

const SOURCE_EXTENSIONS = [
  'java',
  'kt',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'rb',
  'php',
  'cs',
  'c',
  'cpp',
  'h',
];

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** 优先选 src/ 下的源文件，其次任意源文件，最后任意文件。 */
function findInterestingFile(nodes: FileNode[]): string | null {
  const files: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'dir') walk(node.children ?? []);
      else files.push(node.path);
    }
  };
  walk(nodes);
  const sources = files.filter(isSourceFile);
  return sources.find((path) => path.startsWith('src/')) ?? sources[0] ?? files[0] ?? null;
}

/**
 * 首屏自动展开到「第一个源文件」所在目录。
 * 目的很朴素：打开工作区就能看见一个可以点开的代码文件，
 * 而不是面对一堆折叠的目录点五下。
 */
function autoExpand(root: FileNode | null): Set<string> {
  const result = new Set<string>();
  if (!root) return result;

  const preferred = findInterestingFile(root.children ?? []);
  if (!preferred) {
    for (const node of root.children ?? []) {
      if (node.type === 'dir') result.add(node.path);
    }
    return result;
  }

  const parts = preferred.split('/');
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    result.add(prefix);
  }
  return result;
}

interface IdePageProps {
  workspaceId: number;
  username: string;
  onLogout: () => void;
}

export function IdePage({ workspaceId, username, onLogout }: IdePageProps) {
  const toast = useToast();

  // ------------------------------------------------------------ 工作区 / 文件
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [docText, setDocText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);

  const [creating, setCreating] = useState<CreateTarget | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  // ------------------------------------------------------------ 对话
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [patches, setPatches] = useState<PatchRecord[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('closed');
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  const [patchBusyId, setPatchBusyId] = useState<string | null>(null);
  const [diffPatch, setDiffPatch] = useState<PatchRecord | null>(null);
  const [mode, setMode] = useState<AgentMode>(() => loadMode());

  // ------------------------------------------------- 影响面 / 编译（按补丁 id 索引）
  const [radii, setRadii] = useState<Record<string, RadiusEntry>>({});
  const [compiles, setCompiles] = useState<Record<string, BuildResult>>({});
  const [compileBusyId, setCompileBusyId] = useState<string | null>(null);

  // ------------------------------------------------------------ 布局
  const [layout, setLayout] = useState<Layout>(() => loadLayout());
  const [treeVisible, setTreeVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);

  // ------------------------------------------------- 功能 5-8：宪法 / 地图 / 测试
  const [constitution, setConstitution] = useState<ConstitutionView | null>(null);
  const [constitutionOpen, setConstitutionOpen] = useState(false);
  const [springMapOpen, setSpringMapOpen] = useState(false);
  const [testsOpen, setTestsOpen] = useState(false);

  // ------------------------------------------------- 功能 9：快照与回滚
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [applyAllBusy, setApplyAllBusy] = useState(false);

  // ------------------------------------------------- 功能 11：语义检索
  const [semanticOpen, setSemanticOpen] = useState(false);

  // ------------------------------------------------- 功能 12：终端
  const [terminalOpen, setTerminalOpen] = useState(false);

  // ------------------------------------------------- 功能 13：Agent 工位
  const [desk, setDesk] = useState<DeskView | null>(null);
  const [deskLoading, setDeskLoading] = useState(false);
  const [deskVisible, setDeskVisible] = useState(false);

  // ------------------------------------------------- 功能 14：工具级闸门
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [gateBusyId, setGateBusyId] = useState<string | null>(null);
  const [gatePolicy, setGatePolicy] = useState<GatePolicy>('writes');

  // ------------------------------------------------- 功能 15：平行宇宙
  const [whatIfOpen, setWhatIfOpen] = useState(false);

  // ------------------------------------------------- 功能 16：特性开关
  const [flags, setFlags] = useState<Record<string, FlagEntry>>({});
  const [flagAcks, setFlagAcks] = useState<Set<string>>(() => new Set<string>());

  // ------------------------------------------------- 商业级账号：积分
  /** 顶栏徽标用的轻量概览。完整账单在积分中心页，这里只要余额与告警位。 */
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  /** 余额不足被后端拒掉时置位：输入区上方改为显示「去充值」，而不是一句红字了事。 */
  const [creditBlocked, setCreditBlocked] = useState(false);

  /**
   * 刷新余额。
   *
   * 只在两个时刻调用：进页面时、一轮对话结算后。不做轮询 ——
   * 余额只会被「我自己发起的动作」改变，轮询纯属浪费。
   */
  const refreshCredits = async () => {
    try {
      const summary = await api.creditSummary();
      setCredits(summary);
      updateCredits(summary.balance, summary.lowBalance);
    } catch {
      // 积分是增强信息，拉不到不影响主流程
    }
  };

  // ------------------------------------------------------------ 可变引用
  const turnRef = useRef<LiveTurn | null>(null);
  const sessionIdRef = useRef<number | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  /** 已经为哪些补丁发过影响面请求 —— 防止 patches 每次变化都重发一遍。 */
  const radiusRequested = useRef<Set<string>>(new Set());
  /** 同理，特性开关分析每个补丁只算一次。 */
  const flagRequested = useRef<Set<string>>(new Set());
  const handlersRef = useRef({
    onEvent: (_event: ChatEvent) => {},
    onStatus: (_status: StreamStatus) => {},
  });

  const dirty = file !== null && docText !== savedText;

  useEffect(() => {
    sessionIdRef.current = sessionId;
    selectedPathRef.current = selectedPath;
    dirtyRef.current = dirty;
  }, [sessionId, selectedPath, dirty]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // 宪法状态：进页面拉一次，保存后由 ConstitutionModal 回传更新
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await api.constitution(workspaceId);
        if (!cancelled) setConstitution(view);
      } catch {
        // 宪法是增强能力，拉取失败不打断主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 积分概览：进页面拉一次即可（结算后的刷新由 finishTurn 负责）
  useEffect(() => {
    void refreshCredits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------- 影响面：补丁一出现就去算

  useEffect(() => {
    for (const patch of patches) {
      if (patch.status !== 'pending' || radiusRequested.current.has(patch.id)) continue;
      radiusRequested.current.add(patch.id);
      setRadii((current) => ({
        ...current,
        [patch.id]: { loading: true, error: null, data: current[patch.id]?.data ?? null },
      }));
      void (async () => {
        try {
          const radius = await api.blastRadius(patch.id);
          setRadii((current) => ({
            ...current,
            [patch.id]: { loading: false, error: null, data: radius },
          }));
        } catch (err) {
          setRadii((current) => ({
            ...current,
            [patch.id]: { loading: false, error: messageOf(err), data: null },
          }));
        }
      })();
    }
  }, [patches]);

  // ------------------------------------------------- 特性开关：补丁一出现就去算
  // 与影响面同一节奏。放在这里而不是 PatchCard 里面，是因为 applyAll 也要用到它：
  // 批量应用时得知道「这一批里有没有必须确认开关的补丁」。
  useEffect(() => {
    for (const patch of patches) {
      if (patch.status !== 'pending' || flagRequested.current.has(patch.id)) continue;
      flagRequested.current.add(patch.id);
      setFlags((current) => ({
        ...current,
        [patch.id]: { loading: true, error: null, data: current[patch.id]?.data ?? null },
      }));
      void (async () => {
        try {
          const view = await api.featureFlag(patch.id);
          setFlags((current) => ({
            ...current,
            [patch.id]: { loading: false, error: null, data: view },
          }));
        } catch (err) {
          setFlags((current) => ({
            ...current,
            [patch.id]: { loading: false, error: messageOf(err), data: null },
          }));
        }
      })();
    }
  }, [patches]);

  const ackFlag = (patchId: string, acked: boolean) => {
    setFlagAcks((current) => {
      const next = new Set(current);
      if (acked) next.add(patchId);
      else next.delete(patchId);
      return next;
    });
  };

  // ------------------------------------------------------------ 基础加载

  const refreshTree = async () => {
    try {
      const [root, detail] = await Promise.all([api.tree(workspaceId), api.workspace(workspaceId)]);
      setTree(root);
      setWorkspace(detail);
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setTreeLoading(true);
      setBootError(null);
      try {
        const [detail, info, root, sessionList] = await Promise.all([
          api.workspace(workspaceId),
          api.health(),
          api.tree(workspaceId),
          api.listSessions(workspaceId),
        ]);
        if (cancelled) return;

        setWorkspace(detail);
        setHealth(info);
        setTree(root);
        setExpanded(autoExpand(root));

        if (sessionList.length > 0) {
          setSessions(sessionList);
          setSessionId(sessionList[0].id);
        } else {
          // 没有任何会话就先建一个：这样用户打开页面就能直接提问，
          // 不必先理解「会话」这个概念。
          const created = await api.createSession(workspaceId);
          if (cancelled) return;
          setSessions([created]);
          setSessionId(created.id);
        }
      } catch (err) {
        if (!cancelled) setBootError(messageOf(err));
      } finally {
        if (!cancelled) setTreeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ------------------------------------------------------------ 会话切换

  const refetchChat = async () => {
    const sid = sessionIdRef.current;
    if (sid === null) return;
    try {
      const [msgs, patchList] = await Promise.all([api.listMessages(sid), api.listPatches(sid)]);
      if (sessionIdRef.current !== sid) return;
      setMessages(msgs);
      setPatches(patchList);
    } catch {
      // 本地已有可用结果，这里失败不打断使用
    }
  };

  useEffect(() => {
    turnRef.current = null;
    setTurn(null);
    setSending(false);
    setDiffPatch(null);

    if (sessionId === null) {
      setMessages([]);
      setPatches([]);
      return;
    }

    let cancelled = false;
    setChatLoading(true);
    void (async () => {
      try {
        const [msgs, patchList] = await Promise.all([
          api.listMessages(sessionId),
          api.listPatches(sessionId),
        ]);
        if (cancelled) return;
        setMessages(msgs);
        setPatches(patchList);
      } catch (err) {
        if (!cancelled) toast.error(messageOf(err));
      } finally {
        if (!cancelled) setChatLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ------------------------------------------------------------ 事件处理

  const finishTurn = (assistantMessageId: number) => {
    const finished = turnRef.current;
    turnRef.current = null;
    setTurn(null);
    setSending(false);

    if (finished && Number.isFinite(assistantMessageId)) {
      setMessages((list) => {
        if (list.some((message) => message.id === assistantMessageId)) return list;
        return [
          ...list,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: finished.text,
            meta: { patches: finished.patchIds, citations: finished.citations },
            createdAt: new Date().toISOString(),
          },
        ];
      });
    }
    // 以服务端为准重取（补丁的 messageId 关联等只有在落库后才完整）
    void refetchChat();
    // 这一轮已在服务端按真实 token 用量结算（预扣 → 多退少补），余额要跟着变
    void refreshCredits();
  };

  const handleEvent = (event: ChatEvent) => {
    switch (event.type) {
      case 'text': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        const base = turnRef.current ?? EMPTY_TURN;
        turnRef.current = { ...base, text: base.text + delta };
        setTurn(turnRef.current);
        return;
      }

      case 'tool_call': {
        const base = turnRef.current ?? EMPTY_TURN;
        const item: ToolItem = {
          id: nextToolId(),
          name: String(event.name ?? 'tool'),
          args: event.args ?? {},
          status: 'running',
          summary: '',
        };
        turnRef.current = { ...base, tools: [...base.tools, item] };
        setTurn(turnRef.current);
        return;
      }

      case 'tool_result': {
        const base = turnRef.current ?? EMPTY_TURN;
        const name = String(event.name ?? '');
        const ok = event.ok !== false;
        const summary = typeof event.summary === 'string' ? event.summary : '';
        const tools = [...base.tools];
        for (let i = tools.length - 1; i >= 0; i -= 1) {
          if (tools[i].status === 'running' && tools[i].name === name) {
            tools[i] = { ...tools[i], status: ok ? 'done' : 'failed', summary };
            break;
          }
        }
        turnRef.current = { ...base, tools };
        setTurn(turnRef.current);
        return;
      }

      case 'patch': {
        const id = String(event.id ?? '');
        const sid = sessionIdRef.current;
        if (!id || sid === null) return;
        const record: PatchRecord = {
          id,
          sessionId: sid,
          messageId: null,
          file: String(event.file ?? ''),
          diff: String(event.diff ?? ''),
          status: 'pending',
          createdAt: new Date().toISOString(),
          appliedAt: null,
        };
        setPatches((list) =>
          list.some((patch) => patch.id === id)
            ? list.map((patch) => (patch.id === id ? { ...patch, ...record, messageId: patch.messageId } : patch))
            : [...list, record],
        );
        const base = turnRef.current ?? EMPTY_TURN;
        turnRef.current = {
          ...base,
          patchIds: base.patchIds.includes(id) ? base.patchIds : [...base.patchIds, id],
        };
        setTurn(turnRef.current);
        return;
      }

      case 'citations': {
        const items = Array.isArray(event.items) ? event.items : [];
        const base = turnRef.current;
        if (!base) return;
        turnRef.current = { ...base, citations: items as LiveTurn['citations'] };
        setTurn(turnRef.current);
        return;
      }

      case 'desk': {
        // 工位推的是整块快照，直接替换 —— 状态机只在服务端一处，前端不做推断
        setDesk(event as unknown as DeskView);
        setDeskLoading(false);
        return;
      }

      case 'tool_gate': {
        const gateId = String(event.gateId ?? '');
        if (!gateId) return;
        const gate: PendingGate = {
          gateId,
          sessionId: sessionIdRef.current ?? 0,
          tool: String(event.tool ?? ''),
          intent: String(event.intent ?? ''),
          reason: String(event.reason ?? ''),
          args: (event.args as Record<string, unknown>) ?? {},
          createdAt: new Date().toISOString(),
          expiresAt: typeof event.expiresAt === 'number' ? event.expiresAt : Date.now() + 20000,
        };
        setGates((list) => (list.some((item) => item.gateId === gateId) ? list : [...list, gate]));
        return;
      }

      case 'gate_resolved': {
        const gateId = String(event.gateId ?? '');
        if (!gateId) return;
        setGates((list) => list.filter((item) => item.gateId !== gateId));
        return;
      }

      case 'error': {
        const message = String(event.message ?? '未知错误');
        const base = turnRef.current;
        if (!base || (base.text.length === 0 && base.tools.length === 0)) {
          // 这一轮什么都没产出（例如模型没配置），直接以服务端落库的说明为准
          turnRef.current = null;
          setTurn(null);
          setSending(false);
          void refetchChat();
        } else {
          turnRef.current = { ...base, error: message };
          setTurn(turnRef.current);
          setSending(false);
        }
        toast.error(message);
        return;
      }

      case 'done': {
        finishTurn(Number(event.messageId));
        return;
      }

      default:
        return;
    }
  };

  // 每次渲染后把最新闭包塞进 ref：SSE 连接本身不重建，但回调永远是最新的
  useEffect(() => {
    handlersRef.current = { onEvent: handleEvent, onStatus: setStreamStatus };
  });

  useEffect(() => {
    if (sessionId === null) {
      setStreamStatus('closed');
      return;
    }
    // 令牌在每次建连时现取（必要时静默续期）—— 事件流会重连很多次，
    // 把 2 小时的 access 固定在这里，长会话重连必然撞上过期。
    const handle = openChatStream({
      sessionId,
      getToken: ensureAccessToken,
      afterId: null,
      onEvent: (event) => handlersRef.current.onEvent(event),
      onStatus: (status) => handlersRef.current.onStatus(status),
    });
    return () => handle.close();
  }, [sessionId]);

  // 换会话时把工位 / 闸门拉一次现状：
  // SSE 只推「变化」，刷新页面后拿不到历史 desk 事件，所以这里必须有一次性拉取兜底。
  useEffect(() => {
    setGates([]);
    if (sessionId === null) {
      setDesk(null);
      return;
    }
    let cancelled = false;
    setDeskLoading(true);
    void (async () => {
      try {
        const [snapshot, pending, policy] = await Promise.all([
          api.desk(workspaceId, sessionId),
          api.gates(sessionId),
          api.gatePolicy(sessionId),
        ]);
        if (cancelled) return;
        setDesk(snapshot);
        setGates(pending);
        setGatePolicy(policy.policy);
      } catch {
        // 工位是增强能力，拉取失败不打断主流程
      } finally {
        if (!cancelled) setDeskLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionId]);

  // ------------------------------------------------------------ 文件操作

  const openFile = async (path: string, announce = false) => {
    setSelectedPath(path);
    setFileLoading(true);
    setFileError(null);
    setSelection(null);
    try {
      const content = await api.readFile(workspaceId, path);
      setFile(content);
      setDocText(content.content ?? '');
      setSavedText(content.content ?? '');
    } catch (err) {
      setFile(null);
      setDocText('');
      setSavedText('');
      setFileError(messageOf(err));
      if (announce) {
        toast.error(`打不开 ${path}：${messageOf(err)}`);
      }
    } finally {
      setFileLoading(false);
    }
  };

  /**
   * 引用跳转：对话里点一个 `路径:行号` 时调用。
   *
   * 已经打开且未改动的文件不重新读盘 —— 重新读会丢掉用户正在编辑的内容；
   * 只做「滚到那一行 + 短暂高亮」。
   */
  const openCitation = async (path: string, line: number | null) => {
    if (!path) return;
    if (selectedPathRef.current !== path) {
      await openFile(path, true);
    }
    if (line != null && line > 0) {
      setReveal({ path, line, token: Date.now() });
    }
  };

  const saveFile = async () => {
    const target = file;
    if (!target || target.binary || target.truncated) return;
    if (docText === savedText) return;
    setSaving(true);
    try {
      const saved = await api.saveFile(workspaceId, target.path, docText);
      setFile(saved);
      setDocText(saved.content ?? docText);
      setSavedText(saved.content ?? docText);
      toast.success(`已保存 ${saved.path}`);
      void refreshTree();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd + S 在窗口级别处理：编辑器未聚焦时也应该能保存
  const saveFileRef = useRef(saveFile);
  useEffect(() => {
    saveFileRef.current = saveFile;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveFileRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const createEntry = async (path: string) => {
    const target = creating;
    if (!target) return;
    setCreateBusy(true);
    try {
      await api.createEntry(workspaceId, path, target.type);
      setCreating(null);
      if (target.parent) {
        setExpanded((current) => new Set(current).add(target.parent));
      }
      await refreshTree();
      if (target.type === 'file') {
        await openFile(path);
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const deleteEntry = async (node: FileNode) => {
    const label = node.type === 'dir' ? '目录' : '文件';
    const confirmed = window.confirm(`确定删除${label} “${node.path}” 吗？此操作不可撤销。`);
    if (!confirmed) return;
    try {
      await api.deleteEntry(workspaceId, node.path);
      toast.success(`已删除 ${node.path}`);
      const current = selectedPathRef.current;
      if (current && (current === node.path || current.startsWith(`${node.path}/`))) {
        setSelectedPath(null);
        setFile(null);
        setDocText('');
        setSavedText('');
        setSelection(null);
        setCursor(null);
      }
      await refreshTree();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  // ------------------------------------------------------------ 补丁

  // ------------------------------------------------------------ 编译闭环

  /**
   * 应用补丁之后自动跑一次编译 —— 「Patch → compile → 自动修」里的中间那一环。
   *
   * 之所以自动而不是等用户点：改完不验证等于没改完。失败时不会自动改代码，
   * 只是把编译器输出摆出来，由用户决定要不要让 AI 接着修（人在环上，不越权）。
   */
  const runCompile = async (patch: PatchRecord) => {
    setCompileBusyId(patch.id);
    try {
      const result = await api.compilePatch(patch.id);
      setCompiles((current) => ({ ...current, [patch.id]: result }));
      if (result.status === 'ok') {
        toast.success(`编译通过（${result.buildSystem}，${(result.durationMs / 1000).toFixed(1)}s）`);
      } else if (result.status === 'failed') {
        toast.error(`编译失败：${result.issues.length} 条诊断，可点「让 AI 修复」`);
      } else {
        toast.info(result.note || '编译未执行');
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setCompileBusyId(null);
    }
  };

  /**
   * 把编译器输出整个喂回 Agent，让它出第二轮补丁。
   *
   * 关键是**把原始输出原样带上**，而不是只给一句「编译失败」——
   * 编译器已经把我们想知道的一切写成结构化文本了，转述只会丢信息。
   */
  const fixFromCompile = (patch: PatchRecord, result: BuildResult) => {
    const issues = result.issues
      .slice(0, 40)
      .map((issue) => `- \`${issue.file}${issue.line ? `:${issue.line}` : ''}\` ${issue.message}`)
      .join('\n');
    const tail = result.output.length > 6000 ? result.output.slice(-6000) : result.output;

    const content = [
      `我把你上一个补丁应用到 \`${patch.file}\` 之后，编译失败了，请修复。`,
      '',
      `构建命令：\`${result.command}\`（退出码 ${result.exitCode ?? '未知'}）`,
      issues ? `\n编译器诊断：\n${issues}` : '',
      tail ? `\n原始输出（尾部）：\n\`\`\`text\n${tail}\n\`\`\`` : '',
      '',
      '请只针对这些编译错误给出最小改动的补丁，不要顺手做别的重构。改完说明你改了什么。',
    ]
      .filter((part) => part !== '')
      .join('\n');

    void send(content);
  };

  /**
   * 把测试失败整体喂回 Agent —— 「测试失败驱动改代码」的人工触发点。
   * 带上原始失败明细（类 / 方法 / 行号 / 断言信息），Agent 可以 run_tests 复跑、
   * read_file 定位、propose_patch 出最小修复；修完后用户再跑一次测试验证。
   */
  const fixFromTests = (result: TestRunResult) => {
    setTestsOpen(false);
    const failures = result.failures
      .slice(0, 20)
      .map((failure) => `- \`${failure.displayName}${failure.line ? `:${failure.line}` : ''}\` ${failure.message}`)
      .join('\n');
    // 补丁改了主代码签名、测试代码没跟上的场景：surefire 没跑，失败明细为空，
    // 真正要修的是这些测试代码的编译错误。
    const issues = (result.issues ?? [])
      .slice(0, 20)
      .map((issue) => `- \`${issue.file}${issue.line ? `:${issue.line}` : ''}\` ${issue.message}`)
      .join('\n');
    const tail = result.output.length > 6000 ? result.output.slice(-6000) : result.output;

    const content = [
      '工作区里的测试套件失败了，请修复。',
      '',
      `测试命令：\`${result.command}\`（退出码 ${result.exitCode ?? '未知'}）`,
      result.totals ? `用例统计：共 ${result.totals.run}，失败 ${result.totals.failures}，错误 ${result.totals.errors}` : '',
      failures ? `\n失败用例：\n${failures}` : '',
      issues
        ? `\n注意：失败明细为空、下面是测试代码的编译诊断 —— 测试根本没跑起来。这是测试代码没跟上主代码的新签名，请先修编译错误：\n${issues}`
        : '',
      tail ? `\n原始输出（尾部）：\n\`\`\`text\n${tail}\n\`\`\`` : '',
      '',
      '请先 read_file 打开失败的测试与其测试的源码，判断是实现错了还是断言过时，',
      '然后给出最小改动的补丁；不要顺手做别的重构。修完建议我再跑一次测试验证。',
    ]
      .filter((part) => part !== '')
      .join('\n');

    void send(content);
  };

  const applyPatch = async (patch: PatchRecord) => {
    setPatchBusyId(patch.id);
    try {
      // 改动行为的补丁要带「已确认开关关闭时的旧路径」——前端拦了一层，
      // 后端还会独立校验一次（FLAG_ACK_REQUIRED），这里只是把话提前说清楚。
      const applied = await api.applyPatch(patch.id, flagAcks.has(patch.id));
      setPatches((list) => list.map((item) => (item.id === applied.id ? applied : item)));
      setDiffPatch((current) => (current && current.id === applied.id ? null : current));
      setFlagAcks((current) => {
        const next = new Set(current);
        next.delete(patch.id);
        return next;
      });
      toast.success(`补丁已应用：${applied.file}`);

      if (selectedPathRef.current === applied.file) {
        if (dirtyRef.current) {
          toast.info('磁盘上的文件已更新；当前编辑器里还有未保存的修改，请先保存或手动重开该文件。');
        } else {
          await openFile(applied.file);
        }
      }
      await refreshTree();
      void runCompile(applied);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'FLAG_ACK_REQUIRED') {
        toast.info('这张补丁改动了行为 —— 先在卡片上勾选「已确认开关关闭时的旧路径」，再点应用。');
      } else {
        toast.error(messageOf(err));
      }
    } finally {
      setPatchBusyId(null);
    }
  };

  const rejectPatch = async (patch: PatchRecord) => {
    setPatchBusyId(patch.id);
    try {
      const rejected = await api.rejectPatch(patch.id);
      setPatches((list) => list.map((item) => (item.id === rejected.id ? rejected : item)));
      toast.info(`已丢弃补丁：${rejected.file}`);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setPatchBusyId(null);
    }
  };

  /** 批量应用本会话全部待确认补丁（功能 10）。 */
  const applyAll = async () => {
    const sid = sessionId;
    if (sid === null) return;
    const pending = patches.filter((patch) => patch.status === 'pending');
    if (pending.length < 2) return;
    // 批里若含「必须确认开关」的补丁，只有全部确认过才带 acknowledgeFlag；
    // 否则宁可让它们被逐条挡下（失败明细会写清原因），也不静默跳过这道确认。
    const allFlaggedAcked = pending.every(
      (patch) => !flags[patch.id]?.data?.required || flagAcks.has(patch.id),
    );
    setApplyAllBusy(true);
    try {
      const result = await api.applyAllPatches(sid, allFlaggedAcked);
      const applied = await api.listPatches(sid);
      setPatches(applied);
      await refreshTree();
      if (selectedPathRef.current) {
        await openFile(selectedPathRef.current);
      }
      if (result.failed === 0) {
        toast.success(`已批量应用 ${result.applied} 个补丁（应用前已自动打快照）`);
      } else {
        toast.info(`已应用 ${result.applied}/${result.total} 个；${result.failed} 个失败 —— 失败补丁仍待确认，可逐个查看原因`);
        for (const item of result.items) {
          if (item.error) {
            toast.error(`${item.file}：${item.error}`);
          }
        }
      }
      for (const item of result.items) {
        if (item.status === 'applied') {
          const patch = applied.find((entry) => entry.id === item.patchId);
          if (patch) {
            void runCompile(patch);
          }
        }
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setApplyAllBusy(false);
    }
  };

  // ------------------------------------------------------------ 会话操作

  const send = async (content: string) => {
    const sid = sessionId;
    if (sid === null) {
      toast.error('会话尚未就绪，请稍后再试');
      return;
    }
    setSending(true);
    turnRef.current = { ...EMPTY_TURN };
    setTurn(turnRef.current);

    const optimisticId = -Date.now();
    setMessages((list) => [
      ...list,
      { id: optimisticId, role: 'user', content, meta: null, createdAt: new Date().toISOString() },
    ]);

    try {
      const response = await api.sendMessage(sid, {
        content,
        currentFile: selectedPath,
        selection: selection
          ? { startLine: selection.startLine, endLine: selection.endLine, text: selection.text }
          : null,
        mode,
      });
      setMessages((list) =>
        list.map((message) => (message.id === optimisticId ? { ...message, id: response.messageId } : message)),
      );
    } catch (err) {
      if (err instanceof HttpError && err.code === 'INSUFFICIENT_CREDITS') {
        // 402 的语义不是「没权限」而是「该付钱了」。切出一块常驻的充值入口，
        // 比一闪而过的 Toast 有用得多 —— 用户下一步必然要去充值。
        setCreditBlocked(true);
        void refreshCredits();
      } else {
        toast.error(messageOf(err));
      }
      setMessages((list) => list.filter((message) => message.id !== optimisticId));
      turnRef.current = null;
      setTurn(null);
      setSending(false);
    }
  };

  const createSession = async () => {
    try {
      const session = await api.createSession(workspaceId);
      setSessions((list) => [session, ...list]);
      setSessionId(session.id);
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  // ------------------------------------------------- 功能 14：闸门审批

  /** 放行被拦下的工具调用。`args` 只含人工改过的键，服务端会合进原始参数。 */
  const approveGate = async (gateId: string, args: Record<string, unknown>, note: string) => {
    const sid = sessionId;
    if (sid === null) return;
    setGateBusyId(gateId);
    try {
      await api.approveGate(sid, gateId, args, note);
      setGates((list) => list.filter((item) => item.gateId !== gateId));
      const changed = Object.keys(args).length;
      toast.success(changed > 0 ? `已放行（改了 ${changed} 项参数）—— Agent 用你给的参数继续` : '已放行');
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setGateBusyId(null);
    }
  };

  /** 拦下：模型会收到「已被人拦下」，改用只读手段继续，不会写盘。 */
  const rejectGate = async (gateId: string, note: string) => {
    const sid = sessionId;
    if (sid === null) return;
    setGateBusyId(gateId);
    try {
      await api.rejectGate(sid, gateId, note);
      setGates((list) => list.filter((item) => item.gateId !== gateId));
      toast.info('已拦下这一步 —— Agent 会改用只读手段继续。');
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setGateBusyId(null);
    }
  };

  const changeGatePolicy = async (policy: GatePolicy) => {
    const sid = sessionId;
    if (sid === null) return;
    const previous = gatePolicy;
    setGatePolicy(policy);
    try {
      await api.setGatePolicy(sid, policy);
    } catch (err) {
      setGatePolicy(previous);
      toast.error(messageOf(err));
    }
  };

  /** 采纳平行宇宙后的收尾：把新补丁放进列表，走正常的审查与应用流程。 */
  const onWhatIfAdopted = (patchId: string) => {
    const sid = sessionId;
    if (sid === null) return;
    void (async () => {
      try {
        setPatches(await api.listPatches(sid));
        toast.success(`已采纳到主线（${patchId.slice(0, 8)}）—— 补丁进入待确认，审阅后再应用。`);
      } catch (err) {
        toast.error(messageOf(err));
      }
    })();
  };

  // ------------------------------------------------------------ 布局

  const columns = useMemo(() => {
    const parts: string[] = [];
    // 第一列永远是最左侧的工具轨道（固定宽，不可拖拽）——
    // 它不属于 .pane，所以不会影响「.workbench > .pane / .splitter」这类自检断言。
    parts.push('var(--rail-w)');
    if (treeVisible) parts.push(`minmax(140px, ${layout.left}px)`, '5px');
    parts.push('minmax(0, 1fr)');
    if (chatVisible) parts.push('5px', `minmax(260px, ${layout.right}px)`);
    if (deskVisible) parts.push('5px', `minmax(232px, ${layout.desk}px)`);
    return parts.join(' ');
  }, [treeVisible, chatVisible, deskVisible, layout.left, layout.right, layout.desk]);

  const selectionLines = selection ? selection.endLine - selection.startLine + 1 : 0;
  const saveState: 'clean' | 'dirty' | 'saving' | 'no-file' = !file
    ? 'no-file'
    : saving
      ? 'saving'
      : dirty
        ? 'dirty'
        : 'clean';

  if (bootError) {
    return (
      <div className="centered-page">
        <div className="card">
          <div className="card-head">
            <TerminalMark size={22} />
            <span className="card-title">无法打开工作区</span>
          </div>
          <p className="card-desc">{bootError}</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => navigate('/workspaces')}>
              返回工作区列表
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar
        workspaceName={workspace?.name ?? '加载中…'}
        filePath={selectedPath}
        dirty={dirty}
        health={health}
        username={username}
        onBack={() => navigate('/workspaces')}
        onLogout={onLogout}
        pendingPatches={patches.filter((patch) => patch.status === 'pending').length}
        credits={credits?.balance ?? null}
        creditLow={credits?.lowBalance ?? false}
        onOpenCredits={() => navigate('/credits')}
        onOpenAccount={() => navigate('/account')}
      />

      <div className="workbench" style={{ gridTemplateColumns: columns }}>
        <ToolRail
          constitutionExists={constitution?.exists ?? false}
          deskVisible={deskVisible}
          treeVisible={treeVisible}
          chatVisible={chatVisible}
          activeGates={gates.length}
          onOpenConstitution={() => setConstitutionOpen(true)}
          onOpenSpringMap={() => setSpringMapOpen(true)}
          onOpenTests={() => setTestsOpen(true)}
          onOpenSnapshots={() => setSnapshotsOpen(true)}
          onOpenSemantic={() => setSemanticOpen(true)}
          onOpenTerminal={() => setTerminalOpen(true)}
          onOpenWhatIf={() => setWhatIfOpen(true)}
          onToggleDesk={() => setDeskVisible((value) => !value)}
          onToggleTree={() => setTreeVisible((value) => !value)}
          onToggleChat={() => setChatVisible((value) => !value)}
        />
        {treeVisible && (
          <div className="pane">
            <div className="pane-head">
              <span className="pane-label">文件</span>
              <div className="topbar-spacer" />
              <button
                className="icon-btn"
                title="在根目录新建文件"
                onClick={() => setCreating({ parent: '', type: 'file' })}
              >
                <PlusIcon size={13} />
              </button>
              <button
                className="icon-btn"
                title="在根目录新建目录"
                onClick={() => setCreating({ parent: '', type: 'dir' })}
              >
                <FolderIcon size={13} />
              </button>
              <button className="icon-btn" title="刷新文件树" onClick={() => void refreshTree()}>
                <RefreshIcon size={13} />
              </button>
            </div>
            <div className="pane-body">
              <FileTree
                nodes={tree?.children ?? []}
                loading={treeLoading}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                onSelect={(node) => void openFile(node.path)}
                onRequestCreate={(parent, type) => setCreating({ parent, type })}
                onConfirmCreate={(path) => void createEntry(path)}
                onCancelCreate={() => setCreating(null)}
                onDelete={(node) => void deleteEntry(node)}
                creating={creating}
                createBusy={createBusy}
              />
            </div>
          </div>
        )}

        {treeVisible && (
          <Splitter
            label="调整文件树宽度"
            onResize={(delta) =>
              setLayout((current) => ({ ...current, left: clamp(current.left + delta, 150, 560) }))
            }
            onReset={() => setLayout((current) => ({ ...current, left: DEFAULT_LAYOUT.left }))}
          />
        )}

        <EditorPane
          file={file}
          text={docText}
          loading={fileLoading}
          dirty={dirty}
          saving={saving}
          error={fileError}
          reveal={reveal}
          onChange={setDocText}
          onSave={() => void saveFile()}
          onSelectionChange={setSelection}
          onCursorChange={setCursor}
          onRequestCreate={() => setCreating({ parent: '', type: 'file' })}
        />

        {chatVisible && (
          <Splitter
            label="调整对话面板宽度"
            onResize={(delta) =>
              setLayout((current) => ({ ...current, right: clamp(current.right - delta, 280, 780) }))
            }
            onReset={() => setLayout((current) => ({ ...current, right: DEFAULT_LAYOUT.right }))}
          />
        )}

        {chatVisible && (
          <div className="pane">
            <ChatPane
              sessions={sessions}
              sessionId={sessionId}
              messages={messages}
              turn={turn}
              patches={patches}
              loading={chatLoading}
              sending={sending}
              streamStatus={streamStatus}
              currentFile={selectedPath}
              selection={selection}
              mode={mode}
              onModeChange={setMode}
              onSend={(content) => void send(content)}
              onSelectSession={setSessionId}
              onNewSession={() => void createSession()}
              onClearSelection={() => setSelection(null)}
              onApplyAll={() => void applyAll()}
              applyAllBusy={applyAllBusy}
              patchBusyId={patchBusyId}
              compileBusyId={compileBusyId}
              radiusOf={(patchId) => radii[patchId]?.data ?? null}
              radiusLoading={(patchId) => radii[patchId]?.loading ?? false}
              radiusErrorOf={(patchId) => radii[patchId]?.error ?? null}
              compileOf={(patchId) => compiles[patchId] ?? null}
              onApplyPatch={(patch) => void applyPatch(patch)}
              onRejectPatch={(patch) => void rejectPatch(patch)}
              onViewPatch={setDiffPatch}
              onCompilePatch={(patch) => void runCompile(patch)}
              onFixFromCompile={(patch, result) => fixFromCompile(patch, result)}
              onOpenCitation={(path, line) => void openCitation(path, line)}
              gates={gates}
              gateBusyId={gateBusyId}
              gatePolicy={gatePolicy}
              onApproveGate={(gateId, args, note) => void approveGate(gateId, args, note)}
              onRejectGate={(gateId, note) => void rejectGate(gateId, note)}
              onChangeGatePolicy={(policy) => void changeGatePolicy(policy)}
              flagOf={(patchId) => flags[patchId]?.data ?? null}
              flagLoading={(patchId) => flags[patchId]?.loading ?? false}
              flagErrorOf={(patchId) => flags[patchId]?.error ?? null}
              flagAckedOf={(patchId) => flagAcks.has(patchId)}
              onAckFlag={ackFlag}
              creditBlocked={creditBlocked}
              creditBalance={credits?.balance ?? null}
              creditLow={credits?.lowBalance ?? false}
              onRecharge={() => navigate('/credits')}
            />
          </div>
        )}

        {deskVisible && (
          <Splitter
            label="调整工位面板宽度"
            onResize={(delta) =>
              setLayout((current) => ({ ...current, desk: clamp(current.desk - delta, 232, 560) }))
            }
            onReset={() => setLayout((current) => ({ ...current, desk: DEFAULT_LAYOUT.desk }))}
          />
        )}

        {deskVisible && (
          <div className="pane">
            <AgentDesk
              desk={desk}
              loading={deskLoading}
              live={streamStatus === 'open' || streamStatus === 'connecting'}
              onOpenFile={(path, line) => void openCitation(path, line)}
              onClose={() => setDeskVisible(false)}
            />
          </div>
        )}
      </div>

      <StatusBar
        streamStatus={streamStatus}
        language={file?.language ?? null}
        cursor={cursor}
        selectionLines={selectionLines}
        saveState={saveState}
        workspaceSize={workspace?.sizeBytes ?? 0}
        fileSize={file?.sizeBytes ?? null}
        truncated={file?.truncated ?? false}
        sessionId={sessionId}
      />

      {diffPatch && (
        <PatchModal
          workspaceId={workspaceId}
          patch={diffPatch}
          busy={patchBusyId === diffPatch.id}
          onClose={() => setDiffPatch(null)}
          onApply={(patch) => void applyPatch(patch)}
        />
      )}

      {constitutionOpen && (
        <ConstitutionModal
          workspaceId={workspaceId}
          onClose={() => setConstitutionOpen(false)}
          onSaved={(view) => setConstitution(view)}
        />
      )}

      {springMapOpen && (
        <SpringMapModal
          workspaceId={workspaceId}
          onClose={() => setSpringMapOpen(false)}
          onOpenRef={(path, line) => {
            setSpringMapOpen(false);
            void openCitation(path, line);
          }}
        />
      )}

      {testsOpen && (
        <TestsModal
          workspaceId={workspaceId}
          onClose={() => setTestsOpen(false)}
          onFixWithAi={(result) => fixFromTests(result)}
        />
      )}

      {snapshotsOpen && workspace && (
        <SnapshotsModal
          workspaceId={workspaceId}
          onClose={() => setSnapshotsOpen(false)}
          onRestored={() => {
            void refreshTree();
            if (selectedPath) {
              void openFile(selectedPath);
            }
          }}
        />
      )}

      {semanticOpen && (
        <SemanticModal
          workspaceId={workspaceId}
          onClose={() => setSemanticOpen(false)}
          onOpenHit={(hitPath, hitLine) => void openCitation(hitPath, hitLine)}
        />
      )}

      {terminalOpen && (
        <TerminalModal
          workspaceId={workspaceId}
          onClose={() => setTerminalOpen(false)}
        />
      )}

      {whatIfOpen && (
        <WhatIfPanel
          workspaceId={workspaceId}
          sessionId={sessionId}
          initialFile={selectedPath}
          onClose={() => setWhatIfOpen(false)}
          onAdopted={onWhatIfAdopted}
          onOpenRef={(path, line) => {
            setWhatIfOpen(false);
            void openCitation(path, line);
          }}
        />
      )}
    </div>
  );
}
