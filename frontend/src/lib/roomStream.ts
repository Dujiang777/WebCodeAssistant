import { ensureAccessToken } from './api';
import type { RoomMessage } from './api';

export type RoomStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface OpenRoomStreamOptions {
  afterId: number;
  onMessage: (message: RoomMessage) => void;
  onStatus: (status: RoomStreamStatus) => void;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 10000;

/** 讨论室 SSE。afterId 用最后一条消息的 id，重连时补发漏掉的。 */
export function openRoomStream(options: OpenRoomStreamOptions): { close(): void } {
  const controller = new AbortController();
  let lastId = options.afterId;
  let closed = false;
  let attempt = 0;

  const handleFrame = (frame: string): void => {
    const lines = frame.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let message: RoomMessage;
    try {
      message = JSON.parse(dataLines.join('\n')) as RoomMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && message.id > lastId) {
      lastId = message.id;
      options.onMessage(message);
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
