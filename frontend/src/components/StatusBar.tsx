import { formatBytes } from '../lib/api';
import { streamDotClass, streamLabel } from '../lib/chat';
import type { StreamStatus } from '../lib/sse';

/**
 * 底部状态栏。
 *
 * 信息取舍：只放「解答用户下一秒会问的问题」的字段 ——
 * 光标在哪、这份文件会不会丢、模型通道通不通、工作区还剩多少配额。
 */
interface StatusBarProps {
  streamStatus: StreamStatus;
  language: string | null;
  cursor: { line: number; column: number } | null;
  selectionLines: number;
  saveState: 'clean' | 'dirty' | 'saving' | 'no-file';
  workspaceSize: number;
  fileSize: number | null;
  truncated: boolean;
  sessionId: number | null;
}

export function StatusBar({
  streamStatus,
  language,
  cursor,
  selectionLines,
  saveState,
  workspaceSize,
  fileSize,
  truncated,
  sessionId,
}: StatusBarProps) {
  const sizeRatio = workspaceSize / (200 * 1024 * 1024);
  const quotaTight = sizeRatio > 0.8;

  return (
    <footer className="statusbar">
      <span className="statusbar-item mono">
        工作区 {formatBytes(workspaceSize)} / 200 MB
        {quotaTight && <span style={{ color: 'var(--ember)' }}>· 接近上限</span>}
      </span>

      <span className="statusbar-spacer" />

      {truncated && (
        <span className="statusbar-item" style={{ color: 'var(--ember)' }}>
          文件已截断显示（仅可查看，不能整文件保存）
        </span>
      )}

      {selectionLines > 0 && <span className="statusbar-item">已选 {selectionLines} 行</span>}

      {cursor && (
        <span className="statusbar-item mono">
          行 {cursor.line}，列 {cursor.column}
        </span>
      )}

      {language && <span className="statusbar-item mono">{language}</span>}

      {fileSize !== null && <span className="statusbar-item mono">{formatBytes(fileSize)}</span>}

      <span className="statusbar-item">
        {saveState === 'dirty' && <span style={{ color: 'var(--ember)' }}>未保存</span>}
        {saveState === 'saving' && <span style={{ color: 'var(--cyan)' }}>保存中…</span>}
        {saveState === 'clean' && <span style={{ color: 'var(--lime)' }}>已同步</span>}
        {saveState === 'no-file' && <span style={{ color: 'var(--fg-3)' }}>未打开文件</span>}
      </span>

      <span className="statusbar-item">
        <span className={streamDotClass(streamStatus)} />
        事件流 {streamLabel(streamStatus)}
      </span>

      {sessionId !== null && <span className="statusbar-item mono">会话 #{sessionId}</span>}
    </footer>
  );
}
