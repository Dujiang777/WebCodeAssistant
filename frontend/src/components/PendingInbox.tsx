import { useEffect, useRef, useState } from 'react';

import type { PendingInboxItem } from '../lib/api';

function shortName(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] || path;
}

/**
 * 顶栏待确认收件箱：这个工作区所有会话里还没点的补丁。
 * 点一行会跳到那张卡（必要时先换会话）。
 */
export function PendingInbox({
  items,
  currentSessionId,
  onOpen,
}: {
  items: PendingInboxItem[];
  currentSessionId: number | null;
  onOpen: (item: PendingInboxItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="pending-inbox" ref={rootRef}>
      <button
        className="chip chip-btn"
        style={{ color: 'var(--violet)', borderColor: 'var(--violet-dim)' }}
        onClick={() => setOpen((value) => !value)}
        title="这个工作区里还没确认的补丁，不限当前会话"
      >
        待确认补丁 {items.length}
      </button>
      {open && (
        <div className="pending-inbox-menu" role="listbox" aria-label="待确认补丁">
          <div className="pending-inbox-head">本工作区待确认 {items.length}</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pending-inbox-item${item.sessionId === currentSessionId ? ' on' : ''}`}
              onClick={() => {
                onOpen(item);
                setOpen(false);
              }}
              title={item.file}
            >
              <span className="pending-inbox-file">{shortName(item.file)}</span>
              <span className="pending-inbox-meta">
                {item.sessionTitle}
                {item.sessionId === currentSessionId ? ' · 当前' : ''}
              </span>
              {item.summary ? <span className="pending-inbox-sum">{item.summary}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
