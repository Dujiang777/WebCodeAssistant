import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';

import { api } from '../lib/api';
import type { AuthUser, RoomMessage, RoomNotice, RoomPerson, RoomThread } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { getRoomCodeSnapshot, subscribeRoomFile, subscribeRoomOpen } from '../lib/roomDock';
import { openRoomStream } from '../lib/roomStream';
import type { RoomStreamStatus } from '../lib/roomStream';
import { useToast } from '../lib/toast';

type Tab = 'inbox' | 'public' | 'direct';

const POS_KEY = 'wca.room.pos';
const PAGE = 80;

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

function mergeMessages(current: RoomMessage[], rows: RoomMessage[]): RoomMessage[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const row of rows) merged.set(row.id, row);
  return [...merged.values()].sort((a, b) => a.id - b.id).slice(-800);
}

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const start = (item: Date) => new Date(item.getFullYear(), item.getMonth(), item.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(date)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function noticeLabel(kind: RoomNotice['kind']): string {
  if (kind === 'DIRECT') return '私聊';
  if (kind === 'MENTION') return '点名';
  return '公屏';
}

function quoteText(message: RoomMessage): string {
  if (message.retracted) return '已撤回';
  const text = message.body.trim();
  if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  return message.excerpt ? '一段代码' : '这条消息';
}

function MessageBody({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9_.-]{3,64})/g);
  return (
    <p>
      {parts.map((part, index) =>
        part.startsWith('@') ? (
          <mark key={index} className="room-at">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

/**
 * 全站讨论室。收起时是右下角一颗按钮，点开才是悬浮框。
 * 登录后保持一条 SSE：公屏、私聊、点名和未读提醒都从这条流进来。
 */
export function RoomDock({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const toast = useToast();
  const code = useSyncExternalStore(subscribeRoomFile, getRoomCodeSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('inbox');
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [threads, setThreads] = useState<RoomThread[]>([]);
  const [query, setQuery] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const [hits, setHits] = useState<RoomMessage[] | null>(null);
  const [peerId, setPeerId] = useState<number | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [notices, setNotices] = useState<RoomNotice[]>([]);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<RoomMessage | null>(null);
  const [attachFile, setAttachFile] = useState(true);
  const [status, setStatus] = useState<RoomStreamStatus>(user ? 'connecting' : 'closed');
  const [sending, setSending] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingRetract, setPendingRetract] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLElement | null>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [dragging, setDragging] = useState(false);
  const cornerRef = useRef(corner);
  const skipClick = useRef(false);
  const pinBottom = useRef(true);
  const holdScroll = useRef(false);
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
      setThreads([]);
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
    const loadThreads = () => {
      void api
        .roomThreads()
        .then((rows) => {
          if (!cancelled) setThreads(rows);
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
    loadThreads();
    loadNotices();
    const peopleTimer = window.setInterval(loadPeople, 8000);
    const threadTimer = window.setInterval(loadThreads, 8000);
    const noticeTimer = window.setInterval(loadNotices, 20000);
    const stream = openRoomStream({
      afterId: 0,
      onStatus: setStatus,
      onEvent: (event) => {
        if (event.name === 'presence') {
          if (event.person.id === userId) return;
          setPeople((current) => upsertPerson(current, event.person));
          setThreads((current) =>
            current.map((item) =>
              item.peerId === event.person.id ? { ...item, online: Boolean(event.person.online) } : item,
            ),
          );
          return;
        }
        if (event.name === 'notice') {
          setNotices((current) => {
            if (current.some((item) => item.id === event.notice.id)) return current;
            return [event.notice, ...current].slice(0, 50);
          });
          if (event.notice.kind === 'DIRECT') loadThreads();
          return;
        }
        setMessages((current) => {
          const index = current.findIndex((item) => item.id === event.message.id);
          let next = index >= 0 ? current.slice() : [...current, event.message].slice(-800);
          if (index >= 0) next[index] = event.message;
          if (!event.message.retracted) return next;
          return next.map((item) =>
            item.replyToId === event.message.id ? { ...item, replyRetracted: true, replyPreview: null } : item,
          );
        });
        if (event.message.retracted) {
          setNotices((current) => current.filter((item) => item.messageId !== event.message.id));
          loadThreads();
        } else if (event.message.peerId != null) {
          loadThreads();
        }
      },
    });
    return () => {
      cancelled = true;
      window.clearInterval(peopleTimer);
      window.clearInterval(threadTimer);
      window.clearInterval(noticeTimer);
      stream.close();
    };
  }, [user?.userId]);

  useEffect(() => {
    setReply(null);
    setThreadQuery('');
    setHits(null);
    setPendingRetract(null);
    pinBottom.current = !holdScroll.current;
    holdScroll.current = false;
  }, [tab, peerId]);

  useEffect(() => {
    if (!user || !expanded || tab === 'inbox') return;
    if (tab === 'direct' && peerId === null) return;
    let cancelled = false;
    setHasOlder(false);
    void api
      .roomMessages(tab === 'direct' ? peerId : null)
      .then((rows) => {
        if (cancelled) return;
        setHasOlder(rows.length >= PAGE);
        setMessages((current) => mergeMessages(current, rows));
      })
      .catch(() => {
        if (!cancelled) toast.error('讨论记录加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [user, expanded, tab, peerId, toast]);

  useEffect(() => {
    const q = threadQuery.trim();
    if (!user || !expanded || tab === 'inbox' || !q || (tab === 'direct' && peerId == null)) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .roomSearch(tab === 'direct' ? peerId : null, q)
        .then((rows) => {
          if (!cancelled) setHits(rows);
        })
        .catch(() => {
          if (!cancelled) toast.error('搜索失败');
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [threadQuery, tab, peerId, user, expanded, toast]);

  useEffect(() => {
    if (!user || !expanded || tab === 'inbox') return;
    if (tab === 'public') {
      void api
        .roomRead('PUBLIC', null)
        .then(() =>
          setNotices((current) => current.filter((item) => item.kind !== 'PUBLIC' && item.kind !== 'MENTION')),
        )
        .catch(() => undefined);
      return;
    }
    if (peerId == null) return;
    const peer = peerId;
    void api
      .roomRead('DIRECT', peer)
      .then(() => {
        setNotices((current) => current.filter((item) => !(item.kind === 'DIRECT' && item.senderId === peer)));
        setThreads((current) => current.map((item) => (item.peerId === peer ? { ...item, unread: 0 } : item)));
      })
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

  const searching = threadQuery.trim().length > 0 && (tab === 'public' || peerId != null);
  const shownRows = searching ? hits ?? [] : visibleMessages;

  useEffect(() => {
    const node = scroller.current;
    if (node && pinBottom.current && !searching) node.scrollTop = node.scrollHeight;
  }, [visibleMessages, expanded, tab, searching]);

  useEffect(() => {
    if (focusId == null) return;
    const node = scroller.current?.querySelector(`[data-mid="${focusId}"]`);
    if (!(node instanceof HTMLElement)) return;
    pinBottom.current = false;
    node.scrollIntoView({ block: 'center' });
  }, [focusId, shownRows]);

  useEffect(() => {
    if (focusId == null) return;
    const timer = window.setTimeout(() => setFocusId(null), 2600);
    return () => window.clearTimeout(timer);
  }, [focusId]);

  const shownPeople = people.filter((person) =>
    person.username.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const publicUnread = notices.filter((item) => item.kind === 'PUBLIC' || item.kind === 'MENTION').length;
  const directUnread = notices.filter((item) => item.kind === 'DIRECT').length;
  const peerName = people.find((person) => person.id === peerId)?.username
    ?? threads.find((item) => item.peerId === peerId)?.username
    ?? '';
  const peerOnline = Boolean(
    people.find((person) => person.id === peerId)?.online
    ?? threads.find((item) => item.peerId === peerId)?.online,
  );
  const onlineCount = people.filter((person) => person.online).length;
  const canCompose = tab === 'public' || (tab === 'direct' && peerId != null);
  const mentionQuery = draft.match(/(^|\s)@([A-Za-z0-9_.-]{0,64})$/);
  const mentionChoices = mentionQuery
    ? people
        .filter((person) => person.username.toLowerCase().startsWith(mentionQuery[2].toLowerCase()))
        .slice(0, 6)
    : [];

  const copyExcerpt = (text: string) => {
    void copyText(text).then((ok) => {
      if (ok) toast.info('这段代码已复制');
      else toast.error('复制失败');
    });
  };

  const refreshThreads = () => {
    void api
      .roomThreads()
      .then(setThreads)
      .catch(() => undefined);
  };

  const loadOlder = async () => {
    if (loadingOlder || !hasOlder || searching) return;
    const oldest = visibleMessages[0]?.id;
    if (!oldest) return;
    setLoadingOlder(true);
    pinBottom.current = false;
    const prevHeight = scroller.current?.scrollHeight ?? 0;
    try {
      const rows = await api.roomMessages(tab === 'direct' ? peerId : null, oldest);
      setHasOlder(rows.length >= PAGE);
      setMessages((current) => mergeMessages(current, rows));
      window.requestAnimationFrame(() => {
        const box = scroller.current;
        if (box) box.scrollTop = box.scrollHeight - prevHeight;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更早的消息加载失败');
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !user || !canCompose) return;
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
        reply?.id ?? null,
      );
      setDraft('');
      setReply(null);
      pinBottom.current = true;
      setMessages((current) => (current.some((item) => item.id === saved.id) ? current : [...current, saved]));
      if (tab === 'direct') refreshThreads();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const retract = async (id: number) => {
    if (pendingRetract !== id) {
      setPendingRetract(id);
      return;
    }
    setPendingRetract(null);
    try {
      const saved = await api.roomRetract(id);
      setMessages((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      setNotices((current) => current.filter((item) => item.messageId !== saved.id));
      if (reply?.id === saved.id) setReply(null);
      refreshThreads();
      toast.info('已撤回');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤回失败');
    }
  };

  const pickMention = (username: string) => {
    setDraft((current) => current.replace(/(^|\s)@([A-Za-z0-9_.-]{0,64})$/, `$1@${username} `));
  };

  const openNotice = (notice: RoomNotice) => {
    holdScroll.current = true;
    pinBottom.current = false;
    setFocusId(notice.messageId);
    if (notice.kind === 'DIRECT') {
      setPeerId(notice.senderId);
      setPeople((current) =>
        current.some((person) => person.id === notice.senderId)
          ? current
          : upsertPerson(current, { id: notice.senderId, username: notice.senderName, online: false }),
      );
      setTab('direct');
      return;
    }
    setTab('public');
  };

  const renderMessage = (message: RoomMessage) => (
    <article
      key={message.id}
      data-mid={message.id}
      className={[message.senderId === meId ? 'mine' : '', focusId === message.id ? 'is-focus' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <header>
        <b>{message.senderId === meId ? '我' : message.senderName}</b>
        <time>{clock(message.createdAt)}</time>
        {!message.retracted && (
          <button type="button" className="room-act" onClick={() => setReply(message)}>
            回复
          </button>
        )}
        {message.senderId === meId && !message.retracted && (
          <button type="button" className="room-act" onClick={() => void retract(message.id)}>
            {pendingRetract === message.id ? '确认撤回' : '撤回'}
          </button>
        )}
      </header>
      {message.replyToId != null && (
        <blockquote className="room-quote">
          {message.replyRetracted
            ? '原消息已撤回'
            : `${message.replyName ?? '原消息'}：${message.replyPreview || '一段代码'}`}
        </blockquote>
      )}
      {message.retracted ? (
        <p className="room-gone">已撤回</p>
      ) : (
        <>
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
          <MessageBody text={message.body} />
        </>
      )}
    </article>
  );

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

  const statusText = !user ? '未登录' : status === 'open' ? '实时' : status === 'closed' ? '未连接' : '连接中';
  const statusExtra = tab === 'direct' && peerName
    ? ` · ${peerName}`
    : onlineCount > 0
      ? ` · ${onlineCount} 人在线`
      : '';

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
        if (event.key !== 'Escape') return;
        if (reply) {
          setReply(null);
          return;
        }
        if (threadQuery) {
          setThreadQuery('');
          return;
        }
        setExpanded(false);
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
            {statusText}
            {statusExtra}
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
              {notices.length === 0 && <p className="room-empty">没有未读。别人发来的公屏、点名和私聊会堆在这里。</p>}
              {notices.map((notice) => (
                <button key={notice.id} type="button" className="room-notice" onClick={() => openNotice(notice)}>
                  <header>
                    <b>{notice.senderName}</b>
                    <time>{clock(notice.createdAt)}</time>
                    <span>{noticeLabel(notice.kind)}</span>
                  </header>
                  <p>{notice.preview}</p>
                </button>
              ))}
            </div>
          )}
          {tab === 'direct' && peerId == null && (
            <div className="room-log">
              <input
                className="room-find"
                value={query}
                placeholder="搜索账号，开始私聊"
                aria-label="搜索私聊对象"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query.trim() ? (
                <>
                  {shownPeople.length === 0 && <p className="room-empty">没有这个账号</p>}
                  {shownPeople.map((person) => (
                    <button key={person.id} type="button" className="room-thread" onClick={() => setPeerId(person.id)}>
                      <header>
                        <i className={person.online ? 'on' : ''} />
                        <b>{person.username}</b>
                      </header>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {threads.length === 0 && <p className="room-empty">还没有私聊。搜一个账号就能开始。</p>}
                  {threads.map((thread) => (
                    <button key={thread.peerId} type="button" className="room-thread" onClick={() => setPeerId(thread.peerId)}>
                      <header>
                        <i className={thread.online ? 'on' : ''} />
                        <b>{thread.username}</b>
                        <time>{clock(thread.lastAt)}</time>
                        {thread.unread > 0 && <em>{thread.unread > 99 ? '99+' : thread.unread}</em>}
                      </header>
                      <p>{thread.preview || '（没有文字）'}</p>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {canCompose && (
            <div className="room-peerbar">
              {tab === 'direct' && (
                <button type="button" onClick={() => setPeerId(null)}>
                  返回
                </button>
              )}
              <b>{tab === 'direct' ? peerName || '私聊' : '公屏'}</b>
              {tab === 'direct' && <i className={peerOnline ? 'on' : ''} />}
              <input
                className="room-find"
                value={threadQuery}
                placeholder="搜索这段对话"
                aria-label="搜索这段对话"
                onChange={(event) => setThreadQuery(event.target.value)}
              />
            </div>
          )}
          {canCompose && (
            <div
              className="room-log"
              ref={scroller}
              onScroll={() => {
                const node = scroller.current;
                if (!node) return;
                pinBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
              }}
            >
              {!searching && hasOlder && (
                <button type="button" className="room-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? '加载中' : '更早的消息'}
                </button>
              )}
              {searching && hits == null && <p className="room-empty">正在搜索</p>}
              {searching && hits != null && hits.length === 0 && <p className="room-empty">这段对话里没有找到</p>}
              {!searching && shownRows.length === 0 && (
                <p className="room-empty">还没有消息。@某人，或回复某一条，说说这段代码打算怎么改。</p>
              )}
              {shownRows.map((message, index) => {
                const previous = shownRows[index - 1];
                const showDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
                return (
                  <span key={message.id} className="room-row">
                    {showDay && <i className="room-day">{dayLabel(message.createdAt)}</i>}
                    {renderMessage(message)}
                  </span>
                );
              })}
            </div>
          )}
          {canCompose && (
            <form
              className="room-compose"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {reply && (
                <div className="room-replying">
                  <span>
                    回复 {reply.senderId === meId ? '我' : reply.senderName}：{quoteText(reply)}
                  </span>
                  <button type="button" onClick={() => setReply(null)}>
                    取消
                  </button>
                </div>
              )}
              {mentionChoices.length > 0 && (
                <div className="room-mentions">
                  {mentionChoices.map((person) => (
                    <button key={person.id} type="button" onClick={() => pickMention(person.username)}>
                      @{person.username}
                    </button>
                  ))}
                </div>
              )}
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
                  placeholder={tab === 'public' ? '公屏：@某人，或直接说这段怎么改' : '私聊：只发给对方'}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (mentionChoices.length > 0) {
                        pickMention(mentionChoices[0].username);
                        return;
                      }
                      void send();
                    }
                  }}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !draft.trim()}>
                  发送
                </button>
              </div>
              <p className="room-hint">回车发送，Shift+回车换行，@点名</p>
            </form>
          )}
        </>
      )}
    </section>
  );
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
