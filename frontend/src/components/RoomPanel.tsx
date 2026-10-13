import { useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import type { RoomMessage, RoomPerson } from '../lib/api';
import { openRoomStream } from '../lib/roomStream';
import type { RoomStreamStatus } from '../lib/roomStream';
import { useToast } from '../lib/toast';

interface RoomPanelProps {
  meId: number;
  filePath: string | null;
  onClose: () => void;
}

/**
 * 讨论室：公屏给所有登录用户看，私聊只在双方之间。
 * 可以带上当前打开的文件路径，方便对着代码说怎么改。模型不参与，也不会写盘。
 */
export function RoomPanel({ meId, filePath, onClose }: RoomPanelProps) {
  const toast = useToast();
  const [channel, setChannel] = useState<'public' | 'direct'>('public');
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [peerId, setPeerId] = useState<number | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachFile, setAttachFile] = useState(true);
  const [status, setStatus] = useState<RoomStreamStatus>('connecting');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const activePeer = channel === 'direct' ? peerId : null;

  useEffect(() => {
    void api.roomPeople().then(setPeople).catch(() => toast.error('拉不到在线名单'));
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    void api
      .roomMessages(activePeer)
      .then((rows) => {
        if (cancelled) return;
        setMessages((current) => {
          const merged = new Map(rows.map((row) => [row.id, row]));
          for (const item of current) merged.set(item.id, item);
          return [...merged.values()].sort((a, b) => a.id - b.id);
        });
      })
      .catch(() => {
        if (!cancelled) toast.error('讨论记录加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [activePeer, toast]);

  useEffect(() => {
    const handle = openRoomStream({
      afterId: 0,
      onStatus: setStatus,
      onMessage: (message) => {
        const mine =
          message.peerId == null
            ? channel === 'public'
            : channel === 'direct' &&
              (message.senderId === peerId || message.peerId === peerId) &&
              (message.senderId === meId || message.peerId === meId);
        if (!mine) return;
        setMessages((current) => {
          if (current.some((item) => item.id === message.id)) return current;
          return [...current, message];
        });
      },
    });
    return () => handle.close();
  }, [channel, meId, peerId]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (channel === 'direct' && peerId === null) {
      toast.info('先选一个私聊对象');
      return;
    }
    setSending(true);
    try {
      const saved = await api.roomSend(
        text,
        activePeer,
        attachFile && filePath ? filePath : null,
      );
      setDraft('');
      setMessages((current) => (current.some((item) => item.id === saved.id) ? current : [...current, saved]));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="room-drawer" role="dialog" aria-label="讨论室">
      <header className="room-head">
        <div>
          <b>讨论室</b>
          <span>{status === 'open' ? '实时' : status === 'closed' ? '未连接' : '连接中'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭讨论室">
          ×
        </button>
      </header>
      <div className="room-tabs">
        <button type="button" className={channel === 'public' ? 'on' : ''} onClick={() => setChannel('public')}>
          公屏
        </button>
        <button type="button" className={channel === 'direct' ? 'on' : ''} onClick={() => setChannel('direct')}>
          私聊
        </button>
        {channel === 'direct' && (
          <select
            value={peerId ?? ''}
            onChange={(event) => setPeerId(event.target.value ? Number(event.target.value) : null)}
            aria-label="私聊对象"
          >
            <option value="">选择对象</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.username}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="room-log" ref={scroller}>
        {messages.length === 0 && <p className="room-empty">还没有消息。说说这段代码打算怎么改。</p>}
        {messages.map((message) => (
          <article key={message.id} className={message.senderId === meId ? 'mine' : ''}>
            <header>
              <b>{message.senderId === meId ? '我' : message.senderName}</b>
              <time>{message.createdAt.slice(11, 16)}</time>
            </header>
            {message.filePath && <code>{message.filePath}</code>}
            <p>{message.body}</p>
          </article>
        ))}
      </div>
      <form
        className="room-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={attachFile && Boolean(filePath)}
            disabled={!filePath}
            onChange={(event) => setAttachFile(event.target.checked)}
          />
          {filePath ? `带上 ${filePath.split('/').pop()}` : '未打开文件'}
        </label>
        <div>
          <input
            value={draft}
            maxLength={1000}
            placeholder={channel === 'public' ? '公屏：这段怎么改' : '私聊：只发给对方'}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !draft.trim()}>
            发送
          </button>
        </div>
      </form>
    </aside>
  );
}
