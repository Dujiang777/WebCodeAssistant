import { ensureAccessToken } from './api';
import type { RoomMessage, RoomNotice, RoomPerson } from './api';

export type RoomStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type RoomStreamEvent =
  | { name: 'message'; message: RoomMessage }
  | { name: 'notice'; notice: RoomNotice }
  | { name: 'presence'; person: RoomPerson };

interface OpenRoomStreamOptions {
  afterId: number;
  onEvent: (event: RoomStreamEvent) => void;
  onStatus: (status: RoomStreamStatus) => void;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 10000;

function parsePayload(raw: string): unknown {
  let value: unknown = JSON.parse(raw);
  if (typeof value === 'string') {
    value = JSON.parse(value);
  }
  return value;
}

/** 一条常驻的讨论室 SSE。切公屏/私聊时不要拆掉，漏掉的消息靠 afterId 补。 */
export function openRoomStream(options: OpenRoomStreamOptions): { close(): void } {
  const controller = new AbortController();
  let lastId = options.afterId;
  let closed = false;
  let attempt = 0;

  const handleFrame = (frame: string): void => {
    const lines = frame.split('\n');
    const dataLines: string[] = [];
    let name = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0 || name === 'ready') return;
    let payload: unknown;
    try {
      payload = parsePayload(dataLines.join('\n'));
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    if (name === 'notice' && typeof record.id === 'number') {
      options.onEvent({ name: 'notice', notice: record as unknown as RoomNotice });
      return;
    }
    if (name === 'presence' && typeof record.id === 'number' && typeof record.username === 'string') {
      options.onEvent({
        name: 'presence',
        person: {
          id: record.id,
          username: record.username,
          online: Boolean(record.online),
        },
      });
      return;
    }
    if (typeof record.id === 'number' && record.id > lastId && typeof record.body === 'string') {
      lastId = record.id;
      options.onEvent({ name: 'message', message: record as unknown as RoomMessage });
    }
  };

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
        const token = await ensureAccessToken();
        if (!token) {
          options.onStatus('closed');
          return;
        }
        const response = await fetch(`/api/room/events?afterId=${lastId}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (response.status === 401 || !response.ok || !response.body) {
          if (response.status === 401) {
            options.onStatus('closed');
            return;
          }
          throw new Error(String(response.status));
        }
        options.onStatus('open');
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            handleFrame(buffer.slice(0, separator));
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (closed || controller.signal.aborted) {
          options.onStatus('closed');
          return;
        }
      }
      if (closed) break;
      attempt += 1;
      options.onStatus('reconnecting');
      await new Promise((resolve) =>
        window.setTimeout(resolve, Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)),
      );
    }
    options.onStatus('closed');
  };

  void run();
  return {
    close: () => {
      closed = true;
      controller.abort();
      options.onStatus('closed');
    },
  };
}
