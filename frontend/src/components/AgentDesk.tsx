import type { DeskActivity, DeskView } from '../lib/api';
import { BoltIcon, DiffIcon, FileIcon, SearchIcon, WrenchIcon } from './icons';

/**
 * Agent 工位（功能 13）—— 影子工作区的只读可视化。
 *
 * 这块面板回答一个此前完全看不见的问题：**Agent 现在在我的仓库里做什么？**
 * 默认界面只有「打字机」（文本在流）和「事后话」（一条条工具卡），中间那层
 * 「空间行为」是黑箱。工位把它翻出来：
 *
 *   - 它摊开了哪几个文件、哪个是只读打开、哪个是准备写；
 *   - 光标此刻停在哪个文件的哪一行；
 *   - 正在 grep 什么、范围内有多少命中；
 *   - 草稿 diff 是怎么长出来的（+N / -M）；
 *   - 刚才那一串动作的完整顺序与结果。
 *
 * 三条刻意的克制：
 *   1. **只读**。这里没有任何按钮 —— 要干预请去闸门卡片。工位是仪表盘，不是方向盘。
 *   2. **整块替换渲染**。状态机只在服务端（AgentDeskService），前端不做推断，
 *      避免两处状态机各算各的。
 *   3. **空态说人话**。空闲时不留一块空白，而是告诉用户「这里将会出现什么」。
 */
interface AgentDeskProps {
  desk: DeskView | null;
  /** 首屏拉取中；与「空闲」必须区分开，否则会闪一下空态。 */
  loading: boolean;
  /** 事件流是否连上 —— 断开时面板数据会停住，必须让用户知道。 */
  live: boolean;
  onOpenFile: (path: string, line: number | null) => void;
  onClose: () => void;
}

/** 阶段 → 信号色。跑起来的阶段用主黄铜，写完用青，检索用紫，空闲用灰。 */
function phaseTone(phase: string): string {
  switch (phase) {
    case 'idle':
      return 'var(--fg-3)';
    case 'grep':
    case 'semantic_search':
      return 'var(--violet)';
    case 'propose_patch':
      return 'var(--lime)';
    case 'run_tests':
      return 'var(--amber)';
    default:
      return 'var(--signal)';
  }
}

function shortPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString();
}

function activityDotClass(status: string): string {
  if (status === 'failed') return 'dot dot-err';
  if (status === 'running') return 'dot dot-warn';
  return 'dot dot-ok';
}

export function AgentDesk({ desk, loading, live, onOpenFile, onClose }: AgentDeskProps) {
  const tone = phaseTone(desk?.phase ?? 'idle');
  const running = (desk?.phase ?? 'idle') !== 'idle';

  return (
    <div className="desk">
      <div className="pane-head">
        <WrenchIcon size={13} />
        <span className="pane-label" style={{ letterSpacing: '0.1em' }}>
          工位
        </span>
        {desk && <span className="desk-count" title="本会话累计工具调用次数">{desk.toolCalls} 次调用</span>}
        <div className="topbar-spacer" />
        <button className="icon-btn" title="收起工位面板" onClick={onClose}>
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {!live && (
        <div className="banner">
          <span className="dot dot-warn" />
          事件流未连接 —— 工位显示的是最后一次收到的状态
        </div>
      )}

      {loading && !desk ? (
        <div className="desk-body">
          <div className="loading-block">
            <span className="spinner" />
            <span>正在读取工位…</span>
          </div>
        </div>
      ) : !desk || (desk.phase === 'idle' && desk.timeline.length === 0 && desk.openFiles.length === 0) ? (
        <div className="desk-body">
          <div className="desk-empty">
            <div className="desk-empty-mark">
              <BoltIcon size={20} />
            </div>
            <div className="desk-empty-title">工位还空着</div>
            <div className="desk-empty-text">
              在右边发一条消息，这里会实时显示它在你的仓库里做的每一步 ——
              打开了哪些文件、光标停在哪一行、正在检索什么、草稿 diff 怎么长出来。
            </div>
            <div className="desk-empty-hint">只读面板 · 不会改动任何文件</div>
          </div>
        </div>
      ) : (
        <div className="desk-body">
          {/* 此刻在做什么 —— 面板最上面那行，永远是当前状态 */}
          <div className={`desk-phase${running ? ' running' : ''}`} style={{ ['--desk-tone' as string]: tone }}>
            <span className="desk-phase-dot" />
            <div className="desk-phase-text">
              <div className="desk-phase-label">{desk.phaseLabel}</div>
              {running && desk.activeIntent && <div className="desk-intent">{desk.activeIntent}</div>}
            </div>
            <span className="desk-phase-time">{timeOf(desk.updatedAt)}</span>
          </div>

          {desk.cursorFile && (
            <div className="desk-section">
              <div className="desk-section-head">光标</div>
              <button
                className="desk-cursor"
                title={`跳到 ${desk.cursorFile}${desk.cursorLine ? ` 第 ${desk.cursorLine} 行` : ''}`}
                onClick={() => onOpenFile(desk.cursorFile as string, desk.cursorLine)}
              >
                <FileIcon size={12} />
                <span className="desk-cursor-dir">{dirOf(desk.cursorFile)}</span>
                <span className="desk-cursor-file">{shortPath(desk.cursorFile)}</span>
                {desk.cursorLine != null && <span className="desk-cursor-line">:{desk.cursorLine}</span>}
              </button>
            </div>
          )}

          {desk.openFiles.length > 0 && (
            <div className="desk-section">
              <div className="desk-section-head">
                摊开的文件
                <span className="desk-section-count">{desk.openFiles.length}</span>
              </div>
              <div className="desk-files">
                {desk.openFiles.map((file) => (
                  <button
                    key={file.path}
                    className="desk-file"
                    title={file.path}
                    onClick={() => onOpenFile(file.path, null)}
                  >
                    <span className={`desk-file-mode ${file.mode === 'write' ? 'write' : 'read'}`}>
                      {file.mode === 'write' ? '写' : '读'}
                    </span>
                    <span className="desk-file-path">{shortPath(file.path)}</span>
                    <span className="desk-file-meta">
                      {file.lines != null ? `${file.lines} 行` : timeOf(file.at)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {desk.grep && (
            <div className="desk-section">
              <div className="desk-section-head">关键字检索</div>
              <div className={`desk-grep ${desk.grep.state}`}>
                <SearchIcon size={12} />
                <span className="desk-grep-pattern">/{desk.grep.pattern}/</span>
                <span className="desk-grep-scope" title={desk.grep.scope}>
                  @ {desk.grep.scope}
                </span>
                <span className="desk-grep-hits">
                  {desk.grep.state === 'running'
                    ? '检索中…'
                    : desk.grep.hits != null
                      ? `${desk.grep.hits} 处`
                      : desk.grep.state === 'failed'
                        ? '失败'
                        : '完成'}
                </span>
              </div>
            </div>
          )}

          {desk.drafts.length > 0 && (
            <div className="desk-section">
              <div className="desk-section-head">
                草稿
                <span className="desk-section-count">{desk.drafts.length}</span>
              </div>
              <div className="desk-drafts">
                {desk.drafts.map((draft) => (
                  <div key={draft.patchId} className="desk-draft" title={`${draft.patchId}\n${draft.file}`}>
                    <DiffIcon size={12} />
                    <span className="desk-draft-file">{shortPath(draft.file)}</span>
                    <span className="desk-draft-stat">
                      <span className="add">+{draft.added}</span>
                      <span className="sep">/</span>
                      <span className="del">-{draft.removed}</span>
                    </span>
                    <span className="desk-draft-time">{timeOf(draft.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {desk.timeline.length > 0 && (
            <div className="desk-section">
              <div className="desk-section-head">
                行为时间线
                <span className="desk-section-count">{desk.timeline.length}</span>
              </div>
              <div className="desk-timeline">
                {desk.timeline.map((row, index) => (
                  <TimelineRow key={`${row.at}-${index}`} row={row} />
                ))}
              </div>
            </div>
          )}

          {desk.lastDirectory && (
            <div className="desk-foot">最近浏览的目录：{desk.lastDirectory}</div>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineRow({ row }: { row: DeskActivity }) {
  return (
    <div className={`desk-timeline-row ${row.status}`}>
      <span className={activityDotClass(row.status)} />
      <span className="desk-timeline-label">{row.label}</span>
      <span className="desk-timeline-summary" title={row.summary}>
        {row.summary || '—'}
      </span>
      <span className="desk-timeline-time">{timeOf(row.at)}</span>
    </div>
  );
}
