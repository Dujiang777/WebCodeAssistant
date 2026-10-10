import { useEffect, useRef, useState } from 'react';

import type {
  AgentMode,
  BlastRadius,
  BuildResult,
  ChatMessage,
  ChatSession,
  FlagView,
  GatePolicy,
  PatchRecord,
  PendingGate,
} from '../lib/api';
import { countInvalid } from '../lib/citations';
import {
  describeTurnStage,
  formatElapsed,
  MODE_META,
  streamLabel,
  summarizeToolArgs,
  toolArgsPeek,
  toolLabel,
  toolPathOf,
} from '../lib/chat';
import type { LiveTurn, Selection, ToolItem } from '../lib/chat';
import type { StreamStatus } from '../lib/sse';
import { CitationText } from './CitationText';
import { GateCard } from './GateCard';
import { PatchCard } from './PatchCard';
import { AvatarMenu } from './AvatarMenu';
import { QuotaBar } from './QuotaBar';
import {
  BoltIcon,
  BookIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  PlusIcon,
  QuoteIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  StopIcon,
  TerminalMark,
  TrashIcon,
} from './icons';

/**
 * 右侧对话面板。
 *
 * 结构上的一个关键决定：把「历史消息」与「正在进行的一轮」分开渲染。
 * 历史来自数据库（刷新后仍在），进行中的一轮来自 SSE 事件流（尚未落库）。
 * 混在一个列表里会因为「回合结束时的落库」产生重排和闪烁，分开之后
 * 流式文本可以独立增长，结束时整块被服务端版本替换。
 *
 * 本轮加入的三样东西都挂在「证据」这条主线上：
 *   - 正文里的 `路径:行号` 是可点的 chip，点一下跳到编辑器对应行；
 *   - 补丁卡片在待确认时展示影响面，已应用时展示编译结果；
 *   - 底部有交付 / 教学两种模式开关，只影响 system prompt。
 */
interface PatchDeps {
  patchBusyId: string | null;
  compileBusyId: string | null;
  radiusOf: (patchId: string) => BlastRadius | null;
  radiusLoading: (patchId: string) => boolean;
  radiusErrorOf: (patchId: string) => string | null;
  /** 特性开关（功能 16）：改动行为的补丁要先确认「开关关闭时的旧路径」。 */
  flagOf: (patchId: string) => FlagView | null;
  flagLoading: (patchId: string) => boolean;
  flagErrorOf: (patchId: string) => string | null;
  flagAckedOf: (patchId: string) => boolean;
  onAckFlag: (patchId: string, acked: boolean) => void;
  compileOf: (patchId: string) => BuildResult | null;
  onApplyPatch: (patch: PatchRecord) => void;
  onRejectPatch: (patch: PatchRecord) => void;
  onViewPatch: (patch: PatchRecord) => void;
  onCompilePatch: (patch: PatchRecord) => void;
  onFixFromCompile: (patch: PatchRecord, result: BuildResult) => void;
  onOpenCitation: (file: string, line: number | null) => void;
}

interface ChatPaneProps extends PatchDeps {
  sessions: ChatSession[];
  sessionId: number | null;
  messages: ChatMessage[];
  turn: LiveTurn | null;
  patches: PatchRecord[];
  loading: boolean;
  sending: boolean;
  streamStatus: StreamStatus;
  currentFile: string | null;
  selection: Selection | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onSend: (content: string) => void;
  /** 停止当前回合（sending 时输入区旁出现停止按钮）。 */
  onStop: () => void;
  /**
   * 重新生成：把最后一条用户消息原样再发一次。
   * 由 IdePage 实现（它才知道消息列表）；本组件只负责渲染那个按钮。
   */
  onRegenerate: () => void;
  onSelectSession: (id: number) => void;
  /** 正在跑回合的会话，下拉里标「运行中」。 */
  liveSessionIds?: number[];
  onNewSession: () => void;
  /** 删除当前会话（后端已有接口，这里只是补上入口）。 */
  onDeleteSession: () => void;
  onClearSelection: () => void;
  onApplyAll: () => void;
  applyAllBusy: boolean;
  /** 功能 14：正被拦下等人放行的工具调用。 */
  gates: PendingGate[];
  gateBusyId: string | null;
  gatePolicy: GatePolicy;
  onApproveGate: (gateId: string, args: Record<string, unknown>, note: string) => void;
  onRejectGate: (gateId: string, note: string) => void;
  onChangeGatePolicy: (policy: GatePolicy) => void;
  /** 积分：余额不足被拒时的常驻横幅（比一闪而过的 Toast 有用得多）。 */
  creditBlocked: boolean;
  /** 当前余额；null 表示还没拉到（不显示，而不是显示 0）。 */
  creditBalance: number | null;
  creditLow: boolean;
  /** 免费额度基准线（注册赠送分）；进度条分母。null = 还没拉到。 */
  creditTotal: number | null;
  /** 当前模型是否自带 Key（自带 Key 不消耗免费额度，进度条换成常驻提示）。 */
  creditByok: boolean;
  /** 下次免费额度重置时间。 */
  quotaResetAt: string | null;
  /** 打开「额度用完」引导弹窗（横幅按钮与弹窗共用）。 */
  onOpenGuide: () => void;
  /** 打开积分中心（顶栏徽标与横幅共用同一个入口）。 */
  onRecharge: () => void;
  /** 退出登录 —— 输入区旁的头像菜单要用（账号/主题/模型服务的枢纽）。 */
  onLogout: () => void;
  /** 当前用户名：消息流左侧头像的首字母。 */
  username: string;
}

function patchesOfMessage(message: ChatMessage, patches: PatchRecord[]): PatchRecord[] {
  if (message.role !== 'assistant') return [];
  const ids = Array.isArray(message.meta?.patches) ? (message.meta.patches as unknown[]) : [];
  if (ids.length === 0) return [];
  const wanted = new Set(ids.map(String));
  return patches.filter((patch) => wanted.has(patch.id));
}

function modelOfMessage(message: ChatMessage): string | null {
  const model = message.meta?.model;
  return typeof model === 'string' ? model : null;
}

function modeOfMessage(message: ChatMessage): string | null {
  const mode = message.meta?.mode;
  return typeof mode === 'string' ? mode : null;
}

/**
 * 这条回答实际扣了多少积分。
 *
 * 记账一定要能落到「哪一句花了多少」上 —— 只给一个总余额，
 * 用户永远无法判断是自己在乱问还是单轮太贵。0 分时不显示（免费回合不占版面）。
 */
function creditsOfMessage(message: ChatMessage): number | null {
  const credits = message.meta?.credits;
  return typeof credits === 'number' && credits > 0 ? credits : null;
}

export function ChatPane({
  sessions,
  sessionId,
  messages,
  turn,
  patches,
  loading,
  sending,
  streamStatus,
  currentFile,
  selection,
  mode,
  onModeChange,
  onSend,
  onStop,
  onRegenerate,
  onSelectSession,
  liveSessionIds = [],
  onNewSession,
  onDeleteSession,
  onClearSelection,
  onApplyAll,
  applyAllBusy,
  gates,
  gateBusyId,
  gatePolicy,
  onApproveGate,
  onRejectGate,
  onChangeGatePolicy,
  creditBlocked,
  creditBalance,
  creditLow,
  creditTotal,
  creditByok,
  quotaResetAt,
  onOpenGuide,
  onRecharge,
  onLogout,
  username,
  patchBusyId,
  compileBusyId,
  radiusOf,
  radiusLoading,
  radiusErrorOf,
  flagOf,
  flagLoading,
  flagErrorOf,
  flagAckedOf,
  onAckFlag,
  compileOf,
  onApplyPatch,
  onRejectPatch,
  onViewPatch,
  onCompilePatch,
  onFixFromCompile,
  onOpenCitation,
}: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);
  /** 当前草稿归属的会话：切会话时先对齐再写回，避免把 A 的半句话写进 B。 */
  const draftSid = useRef<number | null>(null);
  // 回合进行中每秒走一次的时钟：running 工具卡显示「已执行 Ns」
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sending) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    if (sessionId === null) {
      draftSid.current = null;
      setDraft('');
      return;
    }
    let stored = '';
    try {
      stored = localStorage.getItem(`wca.draft.${sessionId}`) ?? '';
    } catch {
      stored = '';
    }
    draftSid.current = sessionId;
    setDraft(stored);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null || draftSid.current !== sessionId) return;
    try {
      if (draft.trim()) localStorage.setItem(`wca.draft.${sessionId}`, draft);
      else localStorage.removeItem(`wca.draft.${sessionId}`);
    } catch {
      // 隐私模式记不住草稿就算了
    }
  }, [draft, sessionId]);

  // 自动滚到底，但用户手动往上翻时不打断他 —— 这是聊天界面的基本礼貌
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, turn?.text, turn?.tools.length, turn?.patchIds.length]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  const submit = () => {
    const content = draft.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
  };

  /**
   * 把一段内容放进输入框 —— 「引用」与「改后重发」共用。
   *
   * <p>{@code replace=true} 时整段替换（改后重发：用户要改的就是原话）；
   * 否则追加成 Markdown 引用块（引用某段回答接着追问）。
   * 两种都自动聚焦并把光标推到末尾，省掉一次点击。
   */
  const putIntoComposer = (content: string, replace: boolean) => {
    const text = content.trim();
    if (!text) return;
    setDraft((current) => {
      if (replace || !current.trim()) return text;
      return `${current.replace(/\s+$/, '')}\n\n> ${text.replace(/\n/g, '\n> ')}\n`;
    });
    window.setTimeout(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    }, 0);
  };

  const deps: PatchDeps = {
    patchBusyId,
    compileBusyId,
    radiusOf,
    radiusLoading,
    radiusErrorOf,
    flagOf,
    flagLoading,
    flagErrorOf,
    flagAckedOf,
    onAckFlag,
    compileOf,
    onApplyPatch,
    onRejectPatch,
    onViewPatch,
    onCompilePatch,
    onFixFromCompile,
    onOpenCitation,
  };

  const livePatchIds = turn?.patchIds ?? [];
  const livePatches = patches.filter((patch) => livePatchIds.includes(patch.id));
  const pendingCount = patches.filter((patch) => patch.status === 'pending').length;
  const stage = turn
    ? describeTurnStage(turn, streamStatus, sending, gates.length)
    : null;
  const elapsed =
    turn?.startedAt && sending && !turn.stopped ? formatElapsed(now - turn.startedAt) : null;

  const renderPatch = (patch: PatchRecord) => (
    <PatchCard
      key={patch.id}
      patch={patch}
      busy={patchBusyId === patch.id}
      radius={radiusOf(patch.id)}
      radiusLoading={radiusLoading(patch.id)}
      radiusError={radiusErrorOf(patch.id)}
      flag={flagOf(patch.id)}
      flagLoading={flagLoading(patch.id)}
      flagError={flagErrorOf(patch.id)}
      flagAcked={flagAckedOf(patch.id)}
      onAckFlag={onAckFlag}
      compileBusy={compileBusyId === patch.id}
      compile={compileOf(patch.id)}
      onApply={onApplyPatch}
      onReject={onRejectPatch}
      onView={onViewPatch}
      onCompile={onCompilePatch}
      onFixFromCompile={onFixFromCompile}
      onOpenRef={onOpenCitation}
    />
  );

  return (
    <div className="chat">
      <div className={`pane-head${sending && !turn?.stopped ? ' pane-head-live' : ''}`}>
        <SearchIcon size={13} />
        <span className="pane-label">
          对话
        </span>
        {sending && stage && !turn?.stopped && (
          <span className="pane-live" title={stage.detail || stage.label}>
            {stage.label}
          </span>
        )}

        <div className="topbar-spacer" />

        <select
          className="session-select"
          value={sessionId ?? ''}
          onChange={(event) => onSelectSession(Number(event.target.value))}
          disabled={sessions.length === 0}
          title="切换会话"
        >
          {sessions.length === 0 && <option value="">（暂无会话）</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              #{session.id} · {session.title}
              {liveSessionIds.includes(session.id) ? ' · 运行中' : ''}
            </option>
          ))}
        </select>

        <button className="icon-btn" title="新建会话" onClick={onNewSession}>
          <PlusIcon size={13} />
        </button>
        <button
          className="icon-btn"
          title={sending ? '请先停止当前回合，再删除会话' : '删除当前会话'}
          onClick={onDeleteSession}
          disabled={sessionId === null || sending}
        >
          <TrashIcon size={13} />
        </button>
      </div>

      {streamStatus === 'reconnecting' && (
        <div className="banner">
          <span className="dot dot-warn" />
          事件流断开，正在重连（会补齐断线期间的事件）
        </div>
      )}

      {/* 免费额度用完是「进来就必须处理」的状态，所以做成常驻横幅而不是 Toast：
          Toast 三秒就没了，而用户下一步一定要做选择（配 Key 或等重置）。 */}
      {creditBlocked && (
        <div className="banner banner-credit">
          <span className="dot dot-err" />
          <span className="banner-text">本周免费额度已用完，本轮对话被拒绝。每周自动重置 500 分。</span>
          <button className="btn btn-primary btn-sm" onClick={onOpenGuide}>
            配置教程
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onRecharge}>
            积分中心
          </button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loading ? (
          <div className="loading-block">
            <span className="spinner" />
            <span>正在读取会话历史…</span>
          </div>
        ) : messages.length === 0 && !turn ? (
          <div className="empty empty-hero">
            <div className="empty-orbit" aria-hidden="true">
              <span className="empty-orbit-ring" />
              <span className="empty-orbit-ring slow" />
              <TerminalMark size={30} className="empty-orbit-mark" />
            </div>
            <p className="empty-kicker">DARKROOM · BRASS</p>
            <div className="empty-title">开始一次对话</div>
            <p className="empty-sub">
              问我关于这个仓库的任何事。回答里的「路径:行号」都能点开核对；要我改代码，
              我会先给补丁 —— 你没点确认之前，我不会动你的文件。
            </p>
            <div className="empty-chips">
              {['解释一下这个类', '这个项目用了什么构建方式？', '把这个类改成构造器注入'].map((item) => (
                <button
                  key={item}
                  className="empty-chip"
                  title="点一下直接发送"
                  onClick={() => onSend(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              <MessageBlock
                key={message.id}
                message={message}
                patches={patches}
                deps={deps}
                username={username}
                onOpenCitation={onOpenCitation}
                onRegenerate={onRegenerate}
                onQuote={(text) => putIntoComposer(text, false)}
                onEditResend={(text) => putIntoComposer(text, true)}
                canRegenerate={!sending && message.role === 'assistant' && index === messages.length - 1}
              />
            ))}

            {turn && (
              <div className="msg msg-role-assistant msg-live">
                <span className="msg-avatar msg-avatar-live" aria-hidden="true">
                  <TerminalMark size={13} />
                </span>
                <div className="msg-main">
                  <div className="msg-head">
                    <span className={`dot ${turn.stopped ? 'dot-idle' : 'dot-warn'}`} />
                    <span>{turn.stopped ? '已停止' : '正在处理'}</span>
                    {elapsed && <span className="turn-elapsed">{elapsed}</span>}
                    {!turn.stopped && sending && (
                      <button
                        className="composer-stop tool-stop"
                        onClick={onStop}
                        title="停止本轮：当前工具跑完即停，半截回答会保留，已预扣的积分退回"
                      >
                        <StopIcon size={11} />
                        停止
                      </button>
                    )}
                  </div>

                  {turn.plan.length > 0 && <PlanCard steps={turn.plan} live={!turn.stopped} />}

                  {turn.tools.length > 0 && (
                    <div className="stack-gap turn-trace">
                      {turn.tools.map((tool) => (
                        <ToolCard key={tool.id} tool={tool} now={now} onOpenPath={onOpenCitation} />
                      ))}
                    </div>
                  )}

                  {!turn.text && sending && stage && (
                    <div className="thinking-row" data-stage={stage.key}>
                      <span className="thinking-rail" aria-hidden="true" />
                      <span className="dots">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="thinking-copy">
                        <span className="thinking-label">{stage.label}</span>
                        {stage.detail ? <span className="thinking-detail">{stage.detail}</span> : null}
                      </span>
                    </div>
                  )}

                  {(turn.text || (sending && !turn.stopped)) && (
                    <div className={`msg-body${turn.text ? '' : ' msg-body-live'}`}>
                      {turn.text ? (
                        <CitationText text={turn.text} citations={turn.citations} onOpen={onOpenCitation} />
                      ) : (
                        <span className="msg-body-placeholder">回答会出现在这里</span>
                      )}
                      {sending && !turn.stopped && <span className="caret" />}
                    </div>
                  )}

                  {livePatches.length > 0 && <div className="stack-gap">{livePatches.map(renderPatch)}</div>}

                  {turn.error && (
                    <div className="banner error">
                      <span className="dot dot-err" />
                      {turn.error}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 闸门卡片不放进滚动区，而是钉在输入框上方 —— 这是一次打断，
          必须让人无从错过；错过了它就超时自动放行了。 */}
      {gates.length > 0 && (
        <div className="gate-stack">
          {gates.map((gate) => (
            <GateCard
              key={gate.gateId}
              gate={gate}
              busy={gateBusyId === gate.gateId}
              onApprove={onApproveGate}
              onReject={onRejectGate}
            />
          ))}
        </div>
      )}

      {/* 免费额度进度条：实心 = 已用，斜纹 = 剩余。挂在输入区正上方，
          「还能说几句话」这件事应该在说话的地方看得见。BYOK 时换成常驻提示。 */}
      {creditTotal !== null && creditBalance !== null && (
        <div className="composer-quota">
          <QuotaBar
            balance={creditBalance}
            total={creditTotal}
            byok={creditByok}
            quotaResetAt={quotaResetAt}
            compact
          />
        </div>
      )}

      <div className="composer">
        <div className="composer-context">
          <div className="mode-toggle" role="group" aria-label="工作模式">
            {(['deliver', 'teach'] as AgentMode[]).map((item) => (
              <button
                key={item}
                className={`mode-btn${mode === item ? ' active' : ''}`}
                title={MODE_META[item].hint}
                onClick={() => onModeChange(item)}
              >
                {item === 'deliver' ? <BoltIcon size={11} /> : <BookIcon size={11} />}
                {MODE_META[item].label}
              </button>
            ))}
          </div>

          <div
            className="mode-toggle gate-policy"
            role="group"
            aria-label="工具闸门策略"
            title="工具级冻结：在写盘 / 跑测试之前先停下来等你放行（功能 14）"
          >
            {(
              [
                ['off', '放行'],
                ['writes', '拦写'],
                ['strict', '严格'],
              ] as [GatePolicy, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                className={`mode-btn${gatePolicy === value ? ' active' : ''}`}
                title={
                  value === 'off'
                    ? '全放行：适合信任模式 / 自动化流程'
                    : value === 'writes'
                      ? '默认：拦下写操作（起草补丁、跑测试）'
                      : '严格：在写操作之外，再拦「范围过大」的检索'
                }
                onClick={() => onChangeGatePolicy(value)}
              >
                {value !== 'off' && <ShieldIcon size={11} />}
                {label}
              </button>
            ))}
          </div>

          {/* 余额常驻在输入区旁边：这是「还能不能说下一句」的直接决定因素，
              藏进设置页会让人对着一轮轮对话猜自己什么时候会用完。 */}
          {creditBalance !== null && (
            <button
              className={`chip chip-btn${creditLow ? ' chip-warn' : ''}`}
              title="本账号剩余积分。每轮对话按真实 token 用量结算（多退少补）。点击查看账单与充值。"
              onClick={onRecharge}
            >
              余额 {creditBalance} 分
            </button>
          )}

          {currentFile ? (
            <button
              type="button"
              className="chip chip-btn"
              title={`${currentFile} · 点一下把路径放进输入框`}
              onClick={() => {
                const mention = `\`${currentFile}\``;
                setDraft((current) => {
                  if (!current.trim()) return `${mention} `;
                  if (current.includes(currentFile)) return current;
                  return `${current.replace(/\s+$/, '')} ${mention} `;
                });
                window.setTimeout(() => textareaRef.current?.focus(), 0);
              }}
            >
              当前文件 · {currentFile.split('/').pop()}
            </button>
          ) : (
            <span className="chip" style={{ color: 'var(--fg-3)' }}>
              未打开文件 · 可从项目结构提问
            </span>
          )}

          {selection && (
            <span className="chip" style={{ color: 'var(--cyan)', borderColor: 'rgba(78,201,216,0.3)' }}>
              选中 第 {selection.startLine}–{selection.endLine} 行 · {selection.text.length} 字符
              <button
                className="icon-btn"
                style={{ width: 14, height: 14 }}
                onClick={onClearSelection}
                title="忽略选区"
              >
                <CloseIcon size={9} />
              </button>
            </span>
          )}

          {pendingCount > 0 && (
            <span className="chip" style={{ color: 'var(--violet)' }}>
              待确认补丁 {pendingCount}
              {pendingCount > 1 && (
                <button
                  className="chip-btn"
                  disabled={applyAllBusy}
                  onClick={onApplyAll}
                  title="批量应用本会话全部待确认补丁（整批打一次快照，失败的不阻断其余）"
                >
                  {applyAllBusy ? '应用中…' : '全部应用'}
                </button>
              )}
            </span>
          )}

          <span className="topbar-spacer" />
          <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{streamLabel(streamStatus)}</span>
        </div>

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={
            mode === 'teach'
              ? '描述你想理解什么。Enter 发送，Shift + Enter 换行。（教学模式：我会解释每一步的动机与取舍）'
              : '描述你想做什么。Enter 发送，Shift + Enter 换行。'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // 输入法合成中（拼音选词）按 Enter 是「确认候选词」，此时绝不能当成发送
            if ((event.nativeEvent as KeyboardEvent).isComposing) return;
            // Shift+Enter 换行；Enter 与 Ctrl/⌘+Enter 都发送 —— 聊天框的通用直觉优先
            if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            submit();
          }}
        />

        <div className="composer-actions">
          <span
            className="composer-hint"
            title="AI 没有任何写盘权限：它只能产出补丁，必须由你点「应用」，磁盘上的文件才会真的被改写。"
          >
            补丁需你确认后才写盘
          </span>
          <span className="topbar-spacer" />
          {/* 头像就在发送键旁边：设置、主题、模型服务在这里抬手即达，
              这是 2026-09-28 重构的核心 —— 用户不该为了换个主题去右上角找入口 */}
          <AvatarMenu direction="up" onLogout={onLogout} />
          {sending && (
            <button
              className="composer-stop"
              onClick={onStop}
              title="停止本轮：当前工具跑完即停，半截回答会保留，已预扣的积分退回"
            >
              <StopIcon size={13} />
            </button>
          )}
          <button
            className="composer-send"
            disabled={sending || draft.trim().length === 0}
            onClick={submit}
            title={sending ? '生成中…' : '发送（Enter；Shift+Enter 换行）'}
          >
            {sending ? <span className="spinner" /> : <SendIcon size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBlock({
  message,
  patches,
  deps,
  username,
  onOpenCitation,
  onRegenerate,
  onQuote,
  onEditResend,
  canRegenerate,
}: {
  message: ChatMessage;
  patches: PatchRecord[];
  deps: PatchDeps;
  username: string;
  onOpenCitation: (file: string, line: number | null) => void;
  /** 让模型重答上一条提问（只有最后一条回答可用）。 */
  onRegenerate: () => void;
  /** 把这段回答作为引用放进输入框，接着追问。 */
  onQuote: (text: string) => void;
  /** 把这条用户消息放回输入框改完再发。 */
  onEditResend: (text: string) => void;
  canRegenerate: boolean;
}) {
  const [copied, setCopied] = useState(false);

  /** 复制原文（Markdown 源文，不是渲染后的文本）——用户拿去贴到 issue / 群里都不会丢格式。 */
  const copy = () => {
    const text = message.content ?? '';
    if (!text.trim()) return;
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };
  const isUser = message.role === 'user';
  const model = modelOfMessage(message);
  const mode = modeOfMessage(message);
  const credits = isUser ? null : creditsOfMessage(message);
  const attached = patchesOfMessage(message, patches);
  const citations = message.meta?.citations;
  const invalid = isUser ? 0 : countInvalid(citations);
  const citeCount = Array.isArray(citations) ? citations.length : 0;
  const plan = !isUser && Array.isArray(message.meta?.plan)
    ? (message.meta.plan as unknown[]).map((step) => String(step)).filter((step) => step.length > 0)
    : [];

  return (
    <div className={`msg msg-role-${isUser ? 'user' : 'assistant'}`}>
      <span className={`msg-avatar${isUser ? ' msg-avatar-user' : ''}`} aria-hidden="true">
        {isUser ? username.charAt(0).toUpperCase() : <TerminalMark size={13} />}
      </span>

      <div className="msg-main">
        <div className="msg-head">
          <span className={`dot ${isUser ? 'dot-ok' : 'dot-warn'}`} />
          <span>{isUser ? '你' : 'AI'}</span>
          {!isUser && message.meta?.stopped === true && (
            <span className="msg-meta" title="你在生成过程中点了停止：已跑完的步骤保留，预扣积分已全额退回">
              已停止 · 积分已退回
            </span>
          )}
          {mode && <span className="msg-meta">{MODE_META[mode as AgentMode]?.label ?? mode}</span>}
          {model && <span className="msg-meta">{model}</span>}
          {!isUser && citeCount > 0 && (
            <span className="msg-meta" title={`这条回答挂了 ${citeCount} 处引用`}>
              引用 {citeCount}
            </span>
          )}
          {!isUser && invalid > 0 && (
            <span className="msg-meta msg-meta-bad" title="这些引用指向的文件在工作区里不存在，或行号越界">
              {invalid} 处引用存疑
            </span>
          )}
          {credits !== null && (
            <span className="msg-meta" title="这一轮按真实 token 用量结算后的扣费（预扣额度会多退少补）">
              −{credits} 分
            </span>
          )}
          <span className="msg-meta">{new Date(message.createdAt).toLocaleTimeString()}</span>
        </div>

        <div className="msg-body">
          {plan.length > 0 && <PlanCard steps={plan} live={false} />}
          {isUser ? (
            message.content || '（空消息）'
          ) : (
            <CitationText text={message.content || '（空消息）'} citations={citations} onOpen={onOpenCitation} />
          )}
        </div>

        {attached.length > 0 && (
          <div className="stack-gap">
            {attached.map((patch) => (
              <PatchCard
                key={patch.id}
                patch={patch}
                busy={deps.patchBusyId === patch.id}
                radius={deps.radiusOf(patch.id)}
                radiusLoading={deps.radiusLoading(patch.id)}
                radiusError={deps.radiusErrorOf(patch.id)}
                flag={deps.flagOf(patch.id)}
                flagLoading={deps.flagLoading(patch.id)}
                flagError={deps.flagErrorOf(patch.id)}
                flagAcked={deps.flagAckedOf(patch.id)}
                onAckFlag={deps.onAckFlag}
                compileBusy={deps.compileBusyId === patch.id}
                compile={deps.compileOf(patch.id)}
                onApply={deps.onApplyPatch}
                onReject={deps.onRejectPatch}
                onView={deps.onViewPatch}
                onCompile={deps.onCompilePatch}
                onFixFromCompile={deps.onFixFromCompile}
                onOpenRef={deps.onOpenCitation}
              />
            ))}
          </div>
        )}

        {/* 消息操作条：一直显示（不做 hover 才出现）—— 找不到的功能等于没有，
            而这条窄带只占 20px，不挤占阅读节奏。 */}
        <div className="msg-actions">
          <button className="msg-action" onClick={copy} title="复制这条消息的原文（Markdown 源码）">
            {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
            {copied ? '已复制' : '复制'}
          </button>
          {isUser ? (
            <button
              className="msg-action"
              onClick={() => onEditResend(message.content ?? '')}
              title="把这句话放回输入框，改完再发"
            >
              <EditIcon size={11} />
              改后重发
            </button>
          ) : (
            <>
              <button
                className="msg-action"
                onClick={() => onQuote(message.content ?? '')}
                title="把这段回答作为引用放进输入框，接着追问"
              >
                <QuoteIcon size={11} />
                引用
              </button>
              {canRegenerate && (
                <button
                  className="msg-action"
                  onClick={onRegenerate}
                  title="让模型重新回答上一条提问（会重新计费一次）"
                >
                  <RefreshIcon size={11} />
                  重新生成
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 计划卡：模型动工前给出的步骤清单。live 时金色呼吸点表示「按这个推进中」。 */
function PlanCard({ steps, live }: { steps: string[]; live: boolean }) {
  return (
    <div className={`plan-card${live ? ' plan-card-live' : ''}`}>
      {/* 批35：显影进度条 —— 计划推进中时卡底有一条循环推进的金线。
          卡片两个伪元素都被批26 的齿孔条占着，这条进度用真实元素承载。 */}
      {live && <span className="plan-develop" aria-hidden="true" />}
      <div className="plan-head">
        <span className={`dot ${live ? 'dot-warn' : 'dot-idle'}`} />
        <span>执行计划</span>
        <span className="plan-count">{steps.length} 步</span>
      </div>
      <ol className="plan-steps">
        {steps.map((step, index) => (
          <li key={`${index}-${step.slice(0, 8)}`}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function ToolCard({
  tool,
  now,
  onOpenPath,
}: {
  tool: ToolItem;
  now: number;
  onOpenPath?: (file: string, line: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = tool.status === 'failed' ? 'failed' : tool.status === 'running' ? 'pending' : '';
  const elapsed =
    tool.status === 'running' ? Math.max(0, Math.round((now - tool.startedAt) / 1000)) : null;
  // 批35：参数铭牌 —— hover 时从右侧抽出「键 值」铭牌，像仪器上翻出来的说明牌。
  // 只取前两个标量参数（长文本走 title 与点击展开的 JSON，不在这里堆版面）。
  const peek = toolArgsPeek(tool.args);
  const path = toolPathOf(tool.name, tool.args);
  const summary = summarizeToolArgs(tool.name, tool.args);

  return (
    <div className={`tool-card ${tone}`}>
      <div className="tool-head" onClick={() => setOpen((value) => !value)} style={{ cursor: 'pointer' }}>
        <span
          className={`dot ${
            tool.status === 'failed' ? 'dot-err' : tool.status === 'running' ? 'dot-warn' : 'dot-ok'
          }`}
        />
        <span className="tool-name">{toolLabel(tool.name)}</span>
        <span className="tool-summary" title={summary}>
          {path && onOpenPath ? (
            <button
              type="button"
              className="tool-path"
              title={`在编辑器打开 ${path}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenPath(path, null);
              }}
            >
              {summary}
            </button>
          ) : (
            summary
          )}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-3)', fontSize: 10.5, flex: 'none' }}>
          {tool.status === 'running'
            ? `执行中…${elapsed !== null && elapsed > 0 ? ` ${elapsed}s` : ''}`
            : tool.summary || (tool.status === 'done' ? '完成' : '失败')}
        </span>
      </div>

      {peek.length > 0 && (
        <div className="tool-args-peek" aria-hidden="true">
          {peek.map((entry) => (
            <span className="tool-peek-row" key={entry.key}>
              <em className="tool-peek-key">{entry.key}</em>
              <span className="tool-peek-value">{entry.value}</span>
            </span>
          ))}
        </div>
      )}

      {open && <pre className="tool-args">{JSON.stringify(tool.args ?? {}, null, 2)}</pre>}
    </div>
  );
}
