import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { api } from '../lib/api';
import type { AuthUser, RoomMessage, RoomNotice, RoomPerson, RoomThread } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { getRoomCodeSnapshot, subscribeRoomFile, subscribeRoomOpen } from '../lib/roomDock';
import { openRoomStream } from '../lib/roomStream';
import type { RoomStreamStatus } from '../lib/roomStream';
import { useToast } from '../lib/toast';

type Tab = 'inbox' | 'public' | 'direct';

const POS_KEY = 'wca.room.pos';
const SIZE_KEY = 'wca.room.size';
const PAGE = 80;
const MIN_W = 300;
const MIN_H = 320;
const DEFAULT_SIZE = { width: 360, height: 400 };

interface Corner {
  right: number;
  bottom: number;
}

interface BoxSize {
  width: number;
  height: number;
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
  return { right: 20, bottom: 28 };
}

function readSize(): BoxSize {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BoxSize>;
      if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return { width: parsed.width, height: parsed.height };
      }
    }
  } catch {
    // 记录坏了就回到默认大小
  }
  return { ...DEFAULT_SIZE };
}

function clampSize(size: BoxSize): BoxSize {
  const maxW = Math.max(MIN_W, window.innerWidth - 16);
  const maxH = Math.max(MIN_H, window.innerHeight - 16);
  return {
    width: Math.min(maxW, Math.max(MIN_W, Math.round(size.width))),
    height: Math.min(maxH, Math.max(MIN_H, Math.round(size.height))),
  };
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

const DRAFT_PREFIX = 'wca.room.draft.';

function channelParts(channel: string): { tab: Tab; peerId: number | null } {
  if (channel === 'public') return { tab: 'public', peerId: null };
  if (channel.startsWith('d:')) {
    const raw = channel.slice(2);
    return { tab: 'direct', peerId: raw === 'x' ? null : Number(raw) };
  }
  return { tab: 'inbox', peerId: null };
}

function draftStoreKey(tab: Tab, peerId: number | null): string {
  if (tab === 'direct') return `${DRAFT_PREFIX}direct.${peerId ?? 'new'}`;
  return `${DRAFT_PREFIX}${tab}`;
}

function MessageBody({ text, onMention }: { text: string; onMention?: (username: string) => void }) {
  const blocks = splitFences(text);
  return (
    <div className="room-body">
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <pre key={index} className="room-fence">
            <code>{block.text}</code>
          </pre>
        ) : (
          <p key={index}>{inlineNodes(block.text, index, onMention)}</p>
        ),
      )}
    </div>
  );
}

function splitFences(text: string): Array<{ kind: 'text' | 'code'; text: string }> {
  const blocks: Array<{ kind: 'text' | 'code'; text: string }> = [];
  const pattern = /```[^\n`]*\n?([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) blocks.push({ kind: 'text', text: text.slice(last, index) });
    blocks.push({ kind: 'code', text: (match[1] ?? '').replace(/\n$/, '') });
    last = index + match[0].length;
  }
  if (last < text.length || blocks.length === 0) blocks.push({ kind: 'text', text: text.slice(last) });
  return blocks.filter((block) => block.kind === 'code' || block.text.length > 0);
}

function inlineNodes(text: string, block: number, onMention?: (username: string) => void) {
  const nodes: Array<string | ReactNode> = [];
  const pattern = /(`[^`\n]+`|https?:\/\/[^\s<]+|@[A-Za-z0-9_.-]{3,64})/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    const key = `${block}-${index}`;
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('@')) {
      const username = token.slice(1);
      nodes.push(
        <button key={key} type="button" className="room-at" onClick={() => onMention?.(username)}>
          {token}
        </button>,
      );
    } else {
      const href = token.replace(/[.,;:!?)。，、]+$/u, '');
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {href}
        </a>,
      );
      if (href.length < token.length) nodes.push(token.slice(href.length));
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
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
  const [editing, setEditing] = useState<RoomMessage | null>(null);
  const [freshIds, setFreshIds] = useState<number[]>([]);
  const [typing, setTyping] = useState<Array<{ id: number; name: string; peerId: number | null; until: number }>>([]);
  const [receipts, setReceipts] = useState<Record<number, number>>({});
  const [attachFile, setAttachFile] = useState(true);
  const [status, setStatus] = useState<RoomStreamStatus>(user ? 'connecting' : 'closed');
  const [sending, setSending] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [readyChannel, setReadyChannel] = useState<string | null>(null);
  const [pendingRetract, setPendingRetract] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [boxSize, setBoxSize] = useState<BoxSize>(readSize);
  const [dragging, setDragging] = useState(false);
  const cornerRef = useRef(corner);
  const sizeRef = useRef(boxSize);
  const skipClick = useRef(false);
  const pinBottom = useRef(true);
  const holdScroll = useRef(false);
  const freshKey = useRef('');
  const draftRef = useRef('');
  const draftChannel = useRef('inbox');
  const draftReady = useRef(false);
  const typingSent = useRef(0);
  draftRef.current = draft;
  const channelKey = tab === 'direct' ? `d:${peerId ?? 'x'}` : tab;
  const historyChannel =
    user && expanded && tab === 'public'
      ? 'public'
      : user && expanded && tab === 'direct' && peerId != null
        ? `direct:${peerId}`
        : null;
  const historyReady = historyChannel != null && readyChannel === historyChannel;
  const meId = user?.userId ?? 0;
  cornerRef.current = corner;
  sizeRef.current = boxSize;

  const place = (next: Corner) => {
    const node = boxRef.current;
    const width = expanded ? sizeRef.current.width : node?.offsetWidth ?? 52;
    const height = expanded ? sizeRef.current.height : node?.offsetHeight ?? 52;
    const clamped = clampCorner(next, width, height);
    cornerRef.current = clamped;
    setCorner(clamped);
  };

  useEffect(() => {
    const fit = () => {
      const nextSize = clampSize(sizeRef.current);
      if (nextSize.width !== sizeRef.current.width || nextSize.height !== sizeRef.current.height) {
        sizeRef.current = nextSize;
        setBoxSize(nextSize);
      }
      place(cornerRef.current);
    };
    const frame = window.requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
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

  const beginResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = sizeRef.current;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const next = clampSize({
        width: origin.width + (startX - ev.clientX),
        height: origin.height + (startY - ev.clientY),
      });
      sizeRef.current = next;
      setBoxSize(next);
      setDragging(true);
      place(cornerRef.current);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(false);
      localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current));
      localStorage.setItem(POS_KEY, JSON.stringify(cornerRef.current));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const spot = expanded
    ? { right: corner.right, bottom: corner.bottom, width: boxSize.width, height: boxSize.height }
    : { right: corner.right, bottom: corner.bottom };

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
        if (event.name === 'typing') {
          if (event.userId === userId) return;
          setTyping((current) => [
            ...current.filter((item) => item.id !== event.userId),
            { id: event.userId, name: event.username, peerId: event.peerId, until: Date.now() + 2800 },
          ]);
          return;
        }
        if (event.name === 'receipt') {
          setReceipts((current) => ({ ...current, [event.userId]: event.lastReadId }));
          return;
        }
        setMessages((current) => {
          const preview = event.message.body.trim().slice(0, 80);
          return mergeMessages(current, [event.message]).map((item) => {
            if (item.replyToId !== event.message.id) return item;
            if (event.message.retracted) return { ...item, replyRetracted: true, replyPreview: null };
            return { ...item, replyRetracted: false, replyPreview: preview || '一段代码' };
          });
        });
        if (event.message.retracted) {
          setNotices((current) => current.filter((item) => item.messageId !== event.message.id));
          loadThreads();
        } else {
          const preview = event.message.body.slice(0, 180);
          setNotices((current) =>
            current.map((item) => (item.messageId === event.message.id ? { ...item, preview } : item)),
          );
          if (event.message.peerId != null) loadThreads();
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
    setEditing(null);
    setThreadQuery('');
    setHits(null);
    setPendingRetract(null);
    pinBottom.current = !holdScroll.current;
    holdScroll.current = false;
  }, [tab, peerId]);

  useEffect(() => {
    if (!draftReady.current) {
      draftReady.current = true;
      draftChannel.current = channelKey;
      setDraft(sessionStorage.getItem(draftStoreKey(tab, peerId)) ?? '');
      return;
    }
    const previous = draftChannel.current;
    if (previous !== channelKey) {
      const from = channelParts(previous);
      if (!editing) sessionStorage.setItem(draftStoreKey(from.tab, from.peerId), draftRef.current);
      draftChannel.current = channelKey;
      const to = channelParts(channelKey);
      setDraft(sessionStorage.getItem(draftStoreKey(to.tab, to.peerId)) ?? '');
      return;
    }
    if (!editing) sessionStorage.setItem(draftStoreKey(tab, peerId), draft);
  }, [channelKey, draft, editing, tab, peerId]);

  useEffect(() => {
    const node = composeRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 40), 120)}px`;
  }, [draft, expanded, tab, peerId]);

  useEffect(() => {
    if (!user || tab !== 'direct' || peerId == null) return;
    let cancelled = false;
    void api
      .roomReceipt(peerId)
      .then((row) => {
        if (!cancelled) setReceipts((current) => ({ ...current, [peerId]: row.lastReadId }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, tab, peerId]);

  useEffect(() => {
    const composing = tab === 'public' || (tab === 'direct' && peerId != null);
    if (!user || !composing || editing || !draft.trim()) return;
    const now = Date.now();
    if (now - typingSent.current < 1400) return;
    typingSent.current = now;
    void api.roomTyping(tab === 'direct' ? peerId : null).catch(() => undefined);
  }, [draft, user, editing, tab, peerId]);

  useEffect(() => {
    if (typing.length === 0) return;
    const timer = window.setTimeout(() => {
      setTyping((current) => current.filter((item) => item.until > Date.now()));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [typing]);

  useEffect(() => {
    if (historyChannel == null) return;
    let cancelled = false;
    setHasOlder(false);
    void api
      .roomMessages(tab === 'direct' ? peerId : null)
      .then((rows) => {
        if (cancelled) return;
        setHasOlder(rows.length >= PAGE);
        setMessages((current) => mergeMessages(current, rows));
        setReadyChannel(historyChannel);
      })
      .catch(() => {
        if (cancelled) return;
        setReadyChannel(historyChannel);
        toast.error('讨论记录加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [historyChannel, tab, peerId, toast]);

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
    if (!user || !expanded || tab === 'inbox' || (tab === 'direct' && peerId == null)) {
      freshKey.current = '';
      return;
    }
    const key = tab === 'public' ? 'public' : `direct:${peerId}`;
    if (freshKey.current !== key) {
      freshKey.current = key;
      const ids =
        tab === 'public'
          ? notices.filter((item) => item.kind === 'PUBLIC' || item.kind === 'MENTION')
          : notices.filter((item) => item.kind === 'DIRECT' && item.senderId === peerId);
      setFreshIds(ids.map((item) => item.messageId));
    }
    if (tab === 'public') {
      void api
        .roomRead('PUBLIC', null)
        .then(() => setNotices((current) => current.filter((item) => item.kind !== 'PUBLIC')))
        .catch(() => undefined);
      return;
    }
    const peer = peerId;
    if (peer == null) return;
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
  const freshSet = useMemo(() => new Set(freshIds), [freshIds]);
  const firstFreshId = searching
    ? null
    : shownRows.find((item) => freshSet.has(item.id) && item.senderId !== meId)?.id ?? null;

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
  const publicUnread = notices.filter((item) => item.kind === 'PUBLIC').length;
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

  const copyExcerpt = (text: string, done = '这段代码已复制') => {
    void copyText(text).then((ok) => {
      if (ok) toast.info(done);
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
    if (editing) {
      setSending(true);
      try {
        const saved = await api.roomEdit(editing.id, text);
        setDraft(sessionStorage.getItem(draftStoreKey(tab, peerId)) ?? '');
        setEditing(null);
        setMessages((current) =>
          current.map((item) => {
            if (item.id === saved.id) return saved;
            if (item.replyToId !== saved.id) return item;
            const preview = saved.body.trim().slice(0, 80);
            return { ...item, replyPreview: preview || '一段代码', replyRetracted: false };
          }),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '修改失败');
      } finally {
        setSending(false);
      }
      return;
    }
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

  const beginEdit = (message: RoomMessage) => {
    setReply(null);
    setPendingRetract(null);
    setEditing(message);
    setDraft(message.body);
  };

  const beginReply = (message: RoomMessage) => {
    if (editing) {
      setEditing(null);
      setDraft(sessionStorage.getItem(draftStoreKey(tab, peerId)) ?? '');
    }
    setReply(message);
  };

  const openPerson = (username: string) => {
    if (!user || username === user.username) return;
    const known = people.find((person) => person.username === username);
    const thread = threads.find((item) => item.username === username);
    const id = known?.id ?? thread?.peerId;
    if (id == null) {
      toast.info('这个账号不在最近的列表里');
      return;
    }
    setPeerId(id);
    setTab('direct');
  };

  const dismiss = async (id: number) => {
    setNotices((current) => current.filter((item) => item.id !== id));
    try {
      await api.roomDismiss(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '这条提醒没能清掉');
    }
  };

  const jumpTo = async (id: number | null | undefined) => {
    if (id == null) return;
    pinBottom.current = false;
    setFocusId(id);
    if (messages.some((item) => item.id === id)) return;
    let before = visibleMessages[0]?.id;
    if (!before) {
      toast.info('这条原消息不在当前记录里');
      return;
    }
    for (let page = 0; page < 4; page += 1) {
      try {
        const rows = await api.roomMessages(tab === 'direct' ? peerId : null, before);
        setHasOlder(rows.length >= PAGE);
        setMessages((current) => mergeMessages(current, rows));
        if (rows.some((item) => item.id === id)) return;
        if (rows.length < PAGE) break;
        before = rows[0]?.id;
        if (!before) break;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '原消息加载失败');
        return;
      }
    }
    toast.info('这条原消息太早了');
  };

  const markAll = async () => {
    try {
      await api.roomRead('ALL', null);
      setNotices([]);
      setThreads((current) => current.map((item) => ({ ...item, unread: 0 })));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '标成已读失败');
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
    if (notice.kind === 'MENTION') void dismiss(notice.id);
    setTab('public');
  };

  const typingHere = typing.filter((item) =>
    tab === 'direct' ? item.id === peerId && item.peerId === meId : item.peerId == null,
  );
  const typingLabel =
    typingHere.length === 0
      ? ''
      : `${typingHere
          .slice(0, 3)
          .map((item) => item.name)
          .join('、')} 正在输入`;
  const readMarkId =
    tab === 'direct' && peerId != null
      ? [...visibleMessages].reverse().find((item) => item.senderId === meId && !item.retracted)?.id
      : undefined;
  const peerCursor = peerId != null ? (receipts[peerId] ?? 0) : 0;

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
        {message.edited && <i className="room-edited">已编辑</i>}
        {!message.retracted && (
          <button type="button" className="room-act" onClick={() => copyExcerpt(message.body, '文字已复制')}>
            复制
          </button>
        )}
        {!message.retracted && (
          <button type="button" className="room-act" onClick={() => beginReply(message)}>
            回复
          </button>
        )}
        {message.senderId === meId && !message.retracted && (
          <button type="button" className="room-act" onClick={() => beginEdit(message)}>
            编辑
          </button>
        )}
        {message.senderId === meId && !message.retracted && (
          <button type="button" className="room-act" onClick={() => void retract(message.id)}>
            {pendingRetract === message.id ? '确认撤回' : '撤回'}
          </button>
        )}
      </header>
      {message.replyToId != null && (
        <button
          type="button"
          className="room-quote"
          disabled={Boolean(message.replyRetracted)}
          onClick={() => void jumpTo(message.replyToId)}
        >
          {message.replyRetracted
            ? '原消息已撤回'
            : `${message.replyName ?? '原消息'}：${message.replyPreview || '一段代码'}`}
        </button>
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
            message.filePath && <code className="room-path">{message.filePath}</code>
          )}
          <MessageBody text={message.body} onMention={openPerson} />
          {message.id === readMarkId && readMarkId <= peerCursor && <i className="room-read">已读</i>}
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
        if (editing) {
          setEditing(null);
          setDraft(sessionStorage.getItem(draftStoreKey(tab, peerId)) ?? '');
          return;
        }
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
      <button
        type="button"
        className="room-resize"
        tabIndex={-1}
        aria-label="拖动调整讨论室大小"
        title="拖动左上角调整大小"
        onPointerDown={beginResize}
      />
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
              {notices.length > 0 && (
                <button type="button" className="room-older" onClick={() => void markAll()}>
                  全部已读
                </button>
              )}
              {notices.length === 0 && <p className="room-empty">没有未读。别人发来的公屏、点名和私聊会堆在这里。</p>}
              {notices.map((notice) => (
                <div key={notice.id} className="room-notice">
                  <button type="button" onClick={() => openNotice(notice)}>
                    <header>
                      <b>{notice.senderName}</b>
                      <time>{clock(notice.createdAt)}</time>
                      <span>{noticeLabel(notice.kind)}</span>
                    </header>
                    <p>{notice.preview}</p>
                  </button>
                  <button type="button" className="room-dismiss" aria-label="忽略这条提醒" onClick={() => void dismiss(notice.id)}>
                    ×
                  </button>
                </div>
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
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query) setQuery('');
                }}
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
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && threadQuery) setThreadQuery('');
                }}
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
                <p className="room-empty">
                  {historyReady
                    ? '还没有消息。@某人，或回复某一条，说说这段代码打算怎么改。'
                    : '正在载入对话'}
                </p>
              )}
              {shownRows.map((message, index) => {
                const previous = shownRows[index - 1];
                const showDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
                return (
                  <span key={message.id} className="room-row">
                    {showDay && <i className="room-day">{dayLabel(message.createdAt)}</i>}
                    {message.id === firstFreshId && <i className="room-new">新消息</i>}
                    {renderMessage(message)}
                  </span>
                );
              })}
            </div>
          )}
          {canCompose && typingLabel && <p className="room-typing">{typingLabel}</p>}
          {canCompose && (
            <form
              className="room-compose"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {editing && (
                <div className="room-replying">
                  <span>正在修改这条消息</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setDraft(sessionStorage.getItem(draftStoreKey(tab, peerId)) ?? '');
                    }}
                  >
                    取消
                  </button>
                </div>
              )}
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
              {!editing && code.excerpt && (
                <label>
                  <input
                    type="checkbox"
                    checked={attachFile}
                    onChange={(event) => setAttachFile(event.target.checked)}
                  />
                  {`带上第 ${code.startLine}–${code.endLine} 行${code.clipped ? '（前 2000 字）' : ''}`}
                </label>
              )}
              <div>
                <textarea
                  ref={composeRef}
                  value={draft}
                  rows={2}
                  maxLength={1000}
                  placeholder={
                    editing ? '修改这条消息' : tab === 'public' ? '公屏：@某人，或直接说这段怎么改' : '私聊：只发给对方'
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' && !draft && !editing && !event.shiftKey) {
                      const mine = [...visibleMessages].reverse().find((item) => item.senderId === meId && !item.retracted);
                      if (mine) {
                        event.preventDefault();
                        beginEdit(mine);
                      }
                      return;
                    }
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
                  {editing ? '保存' : '发送'}
                </button>
              </div>
              <p className="room-hint">回车发送，Shift+回车换行，↑ 改上一条</p>
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
