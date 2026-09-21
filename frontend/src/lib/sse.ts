/**
 * SSE 客户端。
 *
 * 为什么不用原生 EventSource：它无法自定义请求头，而我们用 Bearer token 鉴权。
 * 所以这里用 fetch + ReadableStream 自己解析 SSE 帧，顺带获得两个能力：
 *   - 断线自动重连，并带上最后收到的 seq（后端会回放漏掉的事件）；
 *   - 明确暴露连接状态，UI 可以直接提示「重连中」而不是让用户盯着一个假死的界面。
 */

export interface ChatEvent {
  seq: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'patch' | 'error' | 'done' | string;
  [key: string]: unknown;
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamHandle {
  close(): void;
  lastSeq(): number;
}

interface OpenOptions {
  sessionId: number;
  token: string;
  /** 从哪个 seq 之后开始收；null 表示只要新事件 */
  afterId: number | null;
  onEvent: (event: ChatEvent) => void;
  onStatus: (status: StreamStatus) => void;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 10000;

export function openChatStream(options: OpenOptions): StreamHandle {
  const controller = new AbortController();
  let lastSeq = options.afterId ?? -1;
  let closed = false;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');

        const query = lastSeq >= 0 ? `?afterId=${lastSeq}` : '';
        const response = await fetch(`/api/chat/sessions/${options.sessionId}/events${query}`, {
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (response.status === 401) {
          // 鉴权失败重连也没意义，交给上层走登出流程
          options.onStatus('closed');
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`事件流连接失败（${response.status}）`);
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

          // SSE 以空行分隔事件帧；这里只关心 data: 行
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            handleFrame(frame);
            separator = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (closed || controller.signal.aborted) {
          options.onStatus('closed');
          return;
        }
        // 网络抖动 / 后端重启：退避重连，带上已经收到的位置
      }

      if (closed) break;
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      options.onStatus('reconnecting');
      await sleep(delay);
    }
    options.onStatus('closed');
  };

  const handleFrame = (frame: string): void => {
    const lines = frame.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // 以 ':' 开头的是心跳注释，直接忽略
    }
    if (dataLines.length === 0) return;

    const payload = dataLines.join('\n');
    let event: ChatEvent;
    try {
      event = JSON.parse(payload) as ChatEvent;
    } catch {
      return;
    }
    if (typeof event.seq === 'number' && event.seq > lastSeq) {
      lastSeq = event.seq;
    }
    options.onEvent(event);
  };

  void run();

  return {
    close: () => {
      closed = true;
      controller.abort();
      options.onStatus('closed');
    },
    lastSeq: () => lastSeq,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
