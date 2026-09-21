package com.webcode.assistant.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 会话级 SSE 事件总线。
 *
 * <p>为什么不「在 POST 里直接返回 SseEmitter」：那样每个回合都是一条新连接，断开即丢事件、
 * 也没法重连。这里把<b>事件生产</b>与<b>事件订阅</b>拆开：
 * <ul>
 *   <li>{@code POST /messages} 立即返回 {@code messageId}，Agent 在虚拟线程里异步跑；</li>
 *   <li>{@code GET /events?afterId=} 是独立的订阅通道，断线重连时带上最后收到的 {@code seq}，
 *       漏掉的事件会被补齐；</li>
 *   <li>每个会话维护有界环形缓冲，订阅晚几秒也不会丢事件。</li>
 * </ul>
 *
 * <p>心跳：每 15 秒发一条 SSE 注释行，避免长时间「模型思考中」被中间层当成空闲连接切断。
 */
@Component
public class ChatEventHub {

    private static final Logger log = LoggerFactory.getLogger(ChatEventHub.class);
    private static final int BUFFER_CAPACITY = 4000;
    private static final long SSE_TIMEOUT_MS = 30 * 60 * 1000L;
    private static final long HEARTBEAT_INTERVAL_MS = 15_000L;

    private final Map<Long, SessionChannel> channels = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;

    public ChatEventHub(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public ChatEventPublisher publisher(long sessionId) {
        return new ChatEventPublisher(sessionId, channel(sessionId));
    }

    /**
     * 订阅某会话的事件流。
     *
     * @param afterId 为 null 或负数表示「只要新事件」（前端通常已通过 REST 拉过历史）；
     *                给定时回放 {@code seq > afterId} 的事件
     */
    public SseEmitter subscribe(long sessionId, Long afterId) {
        return channel(sessionId).subscribe(afterId);
    }

    /** 会话被删除时释放资源。 */
    public void dispose(long sessionId) {
        SessionChannel channel = channels.remove(sessionId);
        if (channel != null) {
            channel.closeAll();
        }
    }

    private SessionChannel channel(long sessionId) {
        return channels.computeIfAbsent(sessionId, id -> new SessionChannel(id));
    }

    /** 单个会话的事件缓冲与订阅者集合。状态由监视器保护，发布与订阅都很轻。 */
    final class SessionChannel {

        private final long sessionId;
        private final Deque<ChatEvent> buffer = new ArrayDeque<>(BUFFER_CAPACITY);
        private final List<Subscriber> subscribers = new ArrayList<>();

        /** 递增序号，与 {@link ChatEvent#seq()} 一一对应。 */
        private long nextSeq;

        SessionChannel(long sessionId) {
            this.sessionId = sessionId;
        }

        synchronized void publish(String type, Map<String, Object> body) {
            ChatEvent event = new ChatEvent(++nextSeq, type, body);
            while (buffer.size() >= BUFFER_CAPACITY) {
                buffer.removeFirst();
            }
            buffer.addLast(event);
            for (Subscriber subscriber : new ArrayList<>(subscribers)) {
                subscriber.send(event);
            }
        }

        synchronized SseEmitter subscribe(Long afterId) {
            SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
            Subscriber subscriber = new Subscriber(emitter, objectMapper);
            subscribers.add(subscriber);

            Runnable detach = () -> {
                synchronized (SessionChannel.this) {
                    subscribers.remove(subscriber);
                }
                subscriber.markClosed();
            };
            emitter.onCompletion(detach);
            emitter.onTimeout(detach);
            emitter.onError(throwable -> detach.run());

            if (afterId != null && afterId >= 0) {
                for (ChatEvent event : buffer) {
                    if (event.seq() > afterId) {
                        subscriber.send(event);
                    }
                }
            }
            subscriber.startHeartbeat();

            log.debug("会话 {} 新增订阅者，afterId={}，缓冲 {} 条", sessionId, afterId, buffer.size());
            return emitter;
        }

        synchronized void closeAll() {
            for (Subscriber subscriber : new ArrayList<>(subscribers)) {
                subscriber.complete();
            }
            subscribers.clear();
        }
    }

    /** 一个已连接的客户端。send 失败即判定断开，避免一次异常打断整个广播循环。 */
    static final class Subscriber {

        private final SseEmitter emitter;
        private final ObjectMapper objectMapper;
        private final AtomicBoolean closed = new AtomicBoolean(false);

        Subscriber(SseEmitter emitter, ObjectMapper objectMapper) {
            this.emitter = emitter;
            this.objectMapper = objectMapper;
        }

        void send(ChatEvent event) {
            if (closed.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().data(event.toJson(objectMapper), MediaType.TEXT_PLAIN));
            } catch (IOException | IllegalStateException ex) {
                if (closed.compareAndSet(false, true)) {
                    log.debug("SSE 订阅者断开: {}", ex.getMessage());
                }
            }
        }

        void startHeartbeat() {
            Thread.ofVirtual().name("sse-heartbeat").start(() -> {
                try {
                    while (!closed.get()) {
                        Thread.sleep(HEARTBEAT_INTERVAL_MS);
                        if (!closed.get()) {
                            emitter.send(SseEmitter.event().comment("ping"));
                        }
                    }
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                } catch (IOException | IllegalStateException ex) {
                    closed.set(true);
                }
            });
        }

        void markClosed() {
            closed.set(true);
        }

        void complete() {
            markClosed();
            try {
                emitter.complete();
            } catch (RuntimeException ex) {
                log.debug("关闭 SSE 时异常: {}", ex.getMessage());
            }
        }
    }
}
