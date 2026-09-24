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
import { MODE_META, streamLabel, summarizeToolArgs, toolLabel } from '../lib/chat';
import type { LiveTurn, Selection, ToolItem } from '../lib/chat';
import type { StreamStatus } from '../lib/sse';
import { CitationText } from './CitationText';
import { GateCard } from './GateCard';
import { PatchCard } from './PatchCard';
import { BoltIcon, BookIcon, CloseIcon, PlusIcon, SearchIcon, SendIcon, ShieldIcon } from './icons';

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
  onSelectSession: (id: number) => void;
  onNewSession: () => void;
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
  /** 打开积分中心（顶栏徽标与横幅共用同一个入口）。 */
  onRecharge: () => void;
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
  onSelectSession,
  onNewSession,
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
  onRecharge,
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
  const stickToBottom = useRef(true);

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
      <div className="pane-head">
        <SearchIcon size={13} />
        <span className="pane-label" style={{ letterSpacing: '0.1em' }}>
          对话
        </span>

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
            </option>
          ))}
        </select>

        <button className="icon-btn" title="新建会话" onClick={onNewSession}>
          <PlusIcon size={13} />
        </button>
      </div>

      {streamStatus === 'reconnecting' && (
        <div className="banner">
          <span className="dot dot-warn" />
          事件流断开，正在重连（会补齐断线期间的事件）
        </div>
      )}

      {/* 余额不足是「进来就必须处理」的状态，所以做成常驻横幅而不是 Toast：
          Toast 三秒就没了，而用户下一步一定要去充值。 */}
      {creditBlocked && (
        <div className="banner banner-credit">
          <span className="dot dot-err" />
          <span className="banner-text">积分不足，本轮对话已被拒绝。充值后即可继续。</span>
          <button className="btn btn-primary btn-sm" onClick={onRecharge}>
            去充值
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
          <div className="empty">
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
            {messages.map((message) => (
              <MessageBlock
                key={message.id}
                message={message}
                patches={patches}
                deps={deps}
                onOpenCitation={onOpenCitation}
              />
            ))}

            {turn && (
              <div className="msg msg-role-assistant">
                <div className="msg-head">
                  <span className="dot dot-warn" />
                  <span>正在处理</span>
                </div>

                {turn.tools.length > 0 && (
                  <div className="stack-gap">
                    {turn.tools.map((tool) => (
                      <ToolCard key={tool.id} tool={tool} />
                    ))}
                  </div>
                )}

                {turn.text && (
                  <div className="msg-body">
                    <CitationText text={turn.text} citations={turn.citations} onOpen={onOpenCitation} />
                    {sending && <span className="caret" />}
                  </div>
                )}

                {!turn.text && sending && (
                  <div className="thinking-row">
                    <span className="dots">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span>模型正在思考…</span>
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
            <span className="chip" title={currentFile}>
              当前文件 · {currentFile.split('/').pop()}
            </span>
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
          className="composer-input"
          placeholder={
            mode === 'teach'
              ? '描述你想理解什么。Ctrl/⌘ + Enter 发送。（教学模式：我会解释每一步的动机与取舍）'
              : '描述你想做什么。Ctrl/⌘ + Enter 发送。'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer-actions">
          <span
            className="composer-hint"
            title="AI 没有任何写盘权限：它只能产出补丁，必须由你点「应用」，磁盘上的文件才会真的被改写。"
          >
            补丁需你确认后才写盘
          </span>
          <button className="btn btn-primary" disabled={sending || draft.trim().length === 0} onClick={submit}>
            <SendIcon size={13} />
            {sending ? '生成中…' : '发送'}
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
  onOpenCitation,
}: {
  message: ChatMessage;
  patches: PatchRecord[];
  deps: PatchDeps;
  onOpenCitation: (file: string, line: number | null) => void;
}) {
  const isUser = message.role === 'user';
  const model = modelOfMessage(message);
  const mode = modeOfMessage(message);
  const credits = isUser ? null : creditsOfMessage(message);
  const attached = patchesOfMessage(message, patches);
  const citations = message.meta?.citations;
  const invalid = isUser ? 0 : countInvalid(citations);
  const citeCount = Array.isArray(citations) ? citations.length : 0;

  return (
    <div className={`msg msg-role-${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-head">
        <span className={`dot ${isUser ? 'dot-ok' : 'dot-warn'}`} />
        <span>{isUser ? '你' : 'AI'}</span>
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
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const tone = tool.status === 'failed' ? 'failed' : tool.status === 'running' ? 'pending' : '';

  return (
    <div className={`tool-card ${tone}`}>
      <div className="tool-head" onClick={() => setOpen((value) => !value)} style={{ cursor: 'pointer' }}>
        <span
          className={`dot ${
            tool.status === 'failed' ? 'dot-err' : tool.status === 'running' ? 'dot-warn' : 'dot-ok'
          }`}
        />
        <span className="tool-name">{toolLabel(tool.name)}</span>
        <span className="tool-summary" title={summarizeToolArgs(tool.name, tool.args)}>
          {summarizeToolArgs(tool.name, tool.args)}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-3)', fontSize: 10.5, flex: 'none' }}>
          {tool.status === 'running'
            ? '执行中…'
            : tool.summary || (tool.status === 'done' ? '完成' : '失败')}
        </span>
      </div>

      {open && <pre className="tool-args">{JSON.stringify(tool.args ?? {}, null, 2)}</pre>}
    </div>
  );
}
