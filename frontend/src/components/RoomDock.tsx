import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '../lib/api';
import type { AuthUser, RoomMessage, RoomNotice, RoomPerson } from '../lib/api';
import { getRoomFileSnapshot, subscribeRoomFile, subscribeRoomOpen } from '../lib/roomDock';
import { openRoomStream } from '../lib/roomStream';
import type { RoomStreamStatus } from '../lib/roomStream';
import { useToast } from '../lib/toast';

type Tab = 'inbox' | 'public' | 'direct';

function clock(value: string): string {
  if (typeof value !== 'string') return '';
  const match = value.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? '';
}

function sortPeople(list: RoomPerson[]): RoomPerson[] {
  return [...list].sort((a, b) => {
    const online = Number(Boolean(b.online)) - Number(Boolean(a.online));
    if (online !== 0) return online;
    return b.id - a.id;
  });
}

function upsertPerson(list: RoomPerson[], person: RoomPerson): RoomPerson[] {
  return sortPeople([...list.filter((item) => item.id !== person.id), person]);
}

/**
 * 全站讨论室。收起时是右下角一颗按钮，点开才是悬浮框。
 * 登录后保持一条 SSE：公屏、私聊和未读提醒都从这条流进来，切频道不断开。
 */
export function RoomDock({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const toast = useToast();
  const file = useSyncExternalStore(subscribeRoomFile, getRoomFileSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('inbox');
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [query, setQuery] = useState('');
  const [peerId, setPeerId] = useState<number | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [notices, setNotices] = useState<RoomNotice[]>([]);
  const [draft, setDraft] = useState('');
  const [attachFile, setAttachFile] = useState(true);
  const [status, setStatus] = useState<RoomStreamStatus>(user ? 'connecting' : 'closed');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const meId = user?.userId ?? 0;

  useEffect(() => subscribeRoomOpen(() => setExpanded(true)), []);

  useEffect(() => {
    if (!user) {
      setExpanded(false);
      setNotices([]);
      setPeople([]);
      setMessages([]);
      setStatus('closed');
      return;
    }
    const userId = user.userId;
    let cancelled = false;
    const loadPeople = () => {
      void api
        .roomPeople()
        .then((rows) => {
          if (!cancelled) setPeople(sortPeople(rows));
        })
        .catch(() => undefined);
    };
    const loadNotices = () => {
      void api
        .roomNotices()
        .then((rows) => {
          if (!cancelled) setNotices(rows);
        })
        .catch(() => undefined);
    };
    loadPeople();
    loadNotices();
    const peopleTimer = window.setInterval(loadPeople, 8000);
    const noticeTimer = window.setInterval(loadNotices, 20000);
    const stream = openRoomStream({
      afterId: 0,
      onStatus: setStatus,
      onEvent: (event) => {
        if (event.name === 'presence') {
          if (event.person.id === userId) return;
          setPeople((current) => upsertPerson(current, event.person));
          return;
        }
        if (event.name === 'notice') {
          setNotices((current) => {
            if (current.some((item) => item.id === event.notice.id)) return current;
            return [event.notice, ...current].slice(0, 50);
          });
          return;
        }
        setMessages((current) => {
          if (current.some((item) => item.id === event.message.id)) return current;
          return [...current, event.message].slice(-400);
        });
      },
    });
    return () => {
      cancelled = true;
      window.clearInterval(peopleTimer);
      window.clearInterval(noticeTimer);
      stream.close();
    };
  }, [user?.userId]);

  useEffect(() => {
    if (!user || !expanded || tab === 'inbox') return;
    if (tab === 'direct' && peerId === null) return;
    let cancelled = false;
    void api
      .roomMessages(tab === 'direct' ? peerId : null)
      .then((rows) => {
        if (cancelled) return;
        setMessages((current) => {
          const merged = new Map(current.map((item) => [item.id, item]));
          for (const row of rows) merged.set(row.id, row);
          return [...merged.values()].sort((a, b) => a.id - b.id).slice(-400);
        });
      })
      .catch(() => {
        if (!cancelled) toast.error('讨论记录加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [user, expanded, tab, peerId, toast]);

  useEffect(() => {
    if (!user || !expanded || tab === 'inbox') return;
    if (tab === 'public') {
      void api
        .roomRead('PUBLIC', null)
        .then(() => setNotices((current) => current.filter((item) => item.kind !== 'PUBLIC')))
        .catch(() => undefined);
      return;
    }
    if (peerId == null) return;
    const peer = peerId;
    void api
      .roomRead('DIRECT', peer)
      .then(() =>
        setNotices((current) => current.filter((item) => !(item.kind === 'DIRECT' && item.senderId === peer))),
      )
      .catch(() => undefined);
  }, [user, expanded, tab, peerId, notices.length]);

  const visibleMessages = useMemo(() => {
    if (tab === 'public') return messages.filter((item) => item.peerId == null);
    if (tab === 'direct' && peerId != null) {
      return messages.filter(
        (item) =>
          item.peerId != null &&
          (item.senderId === peerId || item.peerId === peerId) &&
          (item.senderId === meId || item.peerId === meId),
      );
    }
    return [];
  }, [messages, tab, peerId, meId]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visibleMessages, expanded, tab]);

  const shownPeople = people.filter((person) =>
    person.username.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const publicUnread = notices.filter((item) => item.kind === 'PUBLIC').length;
  const directUnread = notices.filter((item) => item.kind === 'DIRECT').length;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !user || tab === 'inbox') return;
    if (tab === 'direct' && peerId === null) {
      toast.info('先选一个私聊对象');
      return;
    }
    setSending(true);
    try {
      const saved = await api.roomSend(
        text,
        tab === 'direct' ? peerId : null,
        attachFile && file.path ? file.path : null,
      );
      setDraft('');
      setMessages((current) => (current.some((item) => item.id === saved.id) ? current : [...current, saved]));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const openNotice = (notice: RoomNotice) => {
    if (notice.kind === 'PUBLIC') {
      setTab('public');
      return;
    }
    setPeerId(notice.senderId);
    setPeople((current) =>
      current.some((person) => person.id === notice.senderId)
        ? current
        : upsertPerson(current, { id: notice.senderId, username: notice.senderName, online: false }),
    );
    setTab('direct');
  };

  if (!expanded) {
    return (
      <button
        type="button"
        className="room-fab"
        onClick={() => (user ? setExpanded(true) : onLogin())}
        aria-label={user ? '打开讨论室' : '登录后打开讨论室'}
      >
        讨论
        {user && notices.length > 0 && <em>{notices.length > 99 ? '99+' : notices.length}</em>}
      </button>
    );
  }

  return (
    <section className="room-dock" role="dialog" aria-label="讨论室">
      <header className="room-head">
        <div>
          <b>讨论室</b>
          <span>{!user ? '未登录' : status === 'open' ? '实时' : status === 'closed' ? '未连接' : '连接中'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={() => setExpanded(false)} title="收起">
          ×
        </button>
      </header>
      {!user ? (
        <div className="room-log">
          <p className="room-empty">登录之后可以在公屏或私聊里商量代码怎么改。</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={onLogin}>
            去登录
          </button>
        </div>
      ) : (
        <>
          <div className="room-tabs">
            <button type="button" className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>
              提醒{notices.length > 0 ? ` ${notices.length}` : ''}
            </button>
            <button type="button" className={tab === 'public' ? 'on' : ''} onClick={() => setTab('public')}>
              公屏{publicUnread > 0 ? ` ${publicUnread}` : ''}
            </button>
            <button type="button" className={tab === 'direct' ? 'on' : ''} onClick={() => setTab('direct')}>
              私聊{directUnread > 0 ? ` ${directUnread}` : ''}
            </button>
          </div>
          {tab === 'inbox' && (
            <div className="room-log">
              {notices.length === 0 && <p className="room-empty">没有未读。别人发来的公屏和私聊会堆在这里。</p>}
              {notices.map((notice) => (
                <button key={notice.id} type="button" className="room-notice" onClick={() => openNotice(notice)}>
                  <header>
                    <b>{notice.senderName}</b>
                    <time>{clock(notice.createdAt)}</time>
                    <span>{notice.kind === 'DIRECT' ? '私聊' : '公屏'}</span>
                  </header>
                  <p>{notice.preview}</p>
                </button>
              ))}
            </div>
          )}
          {tab === 'direct' && (
            <div className="room-people">
              <input
                value={query}
                placeholder="搜索账号"
                aria-label="搜索私聊对象"
                onChange={(event) => setQuery(event.target.value)}
              />
              <div>
                {shownPeople.length === 0 && <p className="room-empty">还没有可以私聊的账号</p>}
                {shownPeople.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={peerId === person.id ? 'on' : ''}
                    onClick={() => setPeerId(person.id)}
                  >
                    <i className={person.online ? 'on' : ''} />
                    {person.username}
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab !== 'inbox' && (
            <div className="room-log" ref={scroller}>
              {tab === 'direct' && peerId === null && <p className="room-empty">先点一个账号，再开始私聊。</p>}
              {visibleMessages.length === 0 && !(tab === 'direct' && peerId === null) && (
                <p className="room-empty">还没有消息。说说这段代码打算怎么改。</p>
              )}
              {visibleMessages.map((message) => (
                <article key={message.id} className={message.senderId === meId ? 'mine' : ''}>
                  <header>
                    <b>{message.senderId === meId ? '我' : message.senderName}</b>
                    <time>{clock(message.createdAt)}</time>
                  </header>
                  {message.filePath && <code>{message.filePath}</code>}
                  <p>{message.body}</p>
                </article>
              ))}
            </div>
          )}
          {tab !== 'inbox' && (
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
                  checked={attachFile && Boolean(file.path)}
                  disabled={!file.path}
                  onChange={(event) => setAttachFile(event.target.checked)}
                />
                {file.path ? `带上 ${file.path.split('/').pop()}` : '未打开文件'}
              </label>
              <div>
                <input
                  value={draft}
                  maxLength={1000}
                  placeholder={tab === 'public' ? '公屏：这段怎么改' : '私聊：只发给对方'}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !draft.trim()}>
                  发送
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
