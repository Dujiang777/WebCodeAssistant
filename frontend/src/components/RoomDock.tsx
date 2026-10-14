import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';

import { api } from '../lib/api';
import type { AuthUser, RoomMessage, RoomNotice, RoomPerson } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { getRoomCodeSnapshot, subscribeRoomFile, subscribeRoomOpen } from '../lib/roomDock';
import { openRoomStream } from '../lib/roomStream';
import type { RoomStreamStatus } from '../lib/roomStream';
import { useToast } from '../lib/toast';

type Tab = 'inbox' | 'public' | 'direct';

const POS_KEY = 'wca.room.pos';

interface Corner {
  right: number;
  bottom: number;
}

function readCorner(): Corner {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Corner>;
      if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number') {
        return { right: parsed.right, bottom: parsed.bottom };
      }
    }
  } catch {
    // 记录坏了就回到默认位置
  }
  return { right: 24, bottom: 120 };
}

function clampCorner(corner: Corner, width: number, height: number): Corner {
  const maxRight = Math.max(8, window.innerWidth - width - 8);
  const maxBottom = Math.max(8, window.innerHeight - height - 8);
  return {
    right: Math.min(maxRight, Math.max(8, corner.right)),
    bottom: Math.min(maxBottom, Math.max(8, corner.bottom)),
  };
}

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
  const code = useSyncExternalStore(subscribeRoomFile, getRoomCodeSnapshot);
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
  const boxRef = useRef<HTMLElement | null>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [dragging, setDragging] = useState(false);
  const cornerRef = useRef(corner);
  const skipClick = useRef(false);
  const meId = user?.userId ?? 0;
  cornerRef.current = corner;

  const place = (next: Corner) => {
    const node = boxRef.current;
    const width = node?.offsetWidth ?? 52;
    const height = node?.offsetHeight ?? 52;
    const clamped = clampCorner(next, width, height);
    cornerRef.current = clamped;
    setCorner(clamped);
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => place(cornerRef.current));
    const onResize = () => place(cornerRef.current);
    window.addEventListener('resize', onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [expanded]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = cornerRef.current;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 5) {
        moved = true;
        setDragging(true);
      }
      place({ right: origin.right - dx, bottom: origin.bottom - dy });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(false);
      if (moved) {
        skipClick.current = true;
        localStorage.setItem(POS_KEY, JSON.stringify(cornerRef.current));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const spot = { right: corner.right, bottom: corner.bottom };

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
  const peerName = people.find((person) => person.id === peerId)?.username ?? '';

  const copyExcerpt = (text: string) => {
    void copyText(text).then((ok) => {
      if (ok) toast.info('这段代码已复制');
      else toast.error('复制失败');
    });
  };

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
        attachFile && code.excerpt ? code.path : null,
        attachFile && code.excerpt ? code.excerpt : null,
        attachFile && code.excerpt ? code.startLine : null,
        attachFile && code.excerpt ? code.endLine : null,
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
        ref={(node) => {
          boxRef.current = node;
        }}
        className={dragging ? 'room-fab is-dragging' : 'room-fab'}
        style={spot}
        title="拖动可以挪开"
        onPointerDown={beginDrag}
        onClick={() => {
          if (skipClick.current) {
            skipClick.current = false;
            return;
          }
          if (user) setExpanded(true);
          else onLogin();
        }}
        aria-label={user ? '打开讨论室' : '登录后打开讨论室'}
      >
        讨论
        {user && notices.length > 0 && <em>{notices.length > 99 ? '99+' : notices.length}</em>}
      </button>
    );
  }

  return (
    <section
      ref={(node) => {
        boxRef.current = node;
      }}
      className={dragging ? 'room-dock is-dragging' : 'room-dock'}
      style={spot}
      role="dialog"
      aria-label="讨论室"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setExpanded(false);
      }}
    >
      <div className="room-sky" aria-hidden="true">
        <i className="room-mist" />
        <i className="room-dust" />
        <i className="room-knot" />
        <i className="room-stars" />
        <i className="room-stars far" />
        <i className="room-stars bright" />
      </div>
      <header
        className="room-head"
        title="拖动标题可以挪开"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button, a, input')) return;
          beginDrag(event);
        }}
      >
        <div>
          <b>讨论室</b>
          <span className={user && status === 'open' ? 'room-live is-on' : 'room-live'}>
            {!user ? '未登录' : status === 'open' ? '实时' : status === 'closed' ? '未连接' : '连接中'}
            {tab === 'direct' && peerName ? ` · ${peerName}` : ''}
          </span>
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
                  {message.excerpt ? (
                    <figure className="room-code">
                      <figcaption>
                        <span>
                          {message.filePath ?? '选中的代码'}
                          {message.excerptStart != null && message.excerptEnd != null
                            ? ` · 第 ${message.excerptStart}–${message.excerptEnd} 行`
                            : ''}
                        </span>
                        <button type="button" onClick={() => copyExcerpt(message.excerpt ?? '')}>
                          复制
                        </button>
                      </figcaption>
                      <pre>{message.excerpt}</pre>
                    </figure>
                  ) : (
                    message.filePath && <code>{message.filePath}</code>
                  )}
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
                  checked={attachFile && Boolean(code.excerpt)}
                  disabled={!code.excerpt}
                  onChange={(event) => setAttachFile(event.target.checked)}
                />
                {code.excerpt
                  ? `带上第 ${code.startLine}–${code.endLine} 行${code.clipped ? '（前 2000 字）' : ''}`
                  : '先选中一段代码再带上'}
              </label>
              <div>
                <textarea
                  value={draft}
                  rows={2}
                  maxLength={1000}
                  placeholder={tab === 'public' ? '公屏：这段怎么改' : '私聊：只发给对方'}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !draft.trim()}>
                  发送
                </button>
              </div>
              <p className="room-hint">回车发送，Shift+回车换行</p>
            </form>
          )}
        </>
      )}
    </section>
  );
}
