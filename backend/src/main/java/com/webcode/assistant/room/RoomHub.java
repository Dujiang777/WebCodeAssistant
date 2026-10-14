package com.webcode.assistant.room;

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
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 讨论室实时通道。
 *
 * <p>data 必须标成 {@code text/plain}。不标的话 Spring 会把已经是 JSON 的字符串再编码一层，
 * 前端 parse 出来是字符串，消息就被丢掉，看起来像「不是实时的」。对话流用的是同一种写法。
 */
@Component
public class RoomHub {

    private static final Logger log = LoggerFactory.getLogger(RoomHub.class);
    private static final int BUFFER = 400;
    private static final long TIMEOUT_MS = 30 * 60 * 1000L;
    private static final long HEARTBEAT_MS = 12_000L;

    private final ObjectMapper objectMapper;
    private final Deque<RoomNote> buffer = new ArrayDeque<>();
    private final List<Subscriber> subscribers = new ArrayList<>();

    public RoomHub(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void publish(RoomNote note) {
        List<Subscriber> targets;
        synchronized (this) {
            Deque<RoomNote> next = new ArrayDeque<>();
            boolean replaced = false;
            for (RoomNote existing : buffer) {
                if (existing.id() == note.id()) {
                    next.addLast(note);
                    replaced = true;
                } else {
                    next.addLast(existing);
                }
            }
            if (!replaced) {
                while (next.size() >= BUFFER) {
                    next.removeFirst();
                }
                next.addLast(note);
            }
            buffer.clear();
            buffer.addAll(next);
            targets = new ArrayList<>();
            for (Subscriber subscriber : subscribers) {
                if (note.visibleTo(subscriber.userId)) {
                    targets.add(subscriber);
                }
            }
        }
        String json = write(note);
        for (Subscriber subscriber : targets) {
            subscriber.send("message", json);
        }
    }

    public void sendTo(long userId, String eventName, Object body) {
        List<Subscriber> targets;
        synchronized (this) {
            targets = subscribers.stream().filter(subscriber -> subscriber.userId == userId).toList();
        }
        String json = write(body);
        for (Subscriber subscriber : targets) {
            subscriber.send(eventName, json);
        }
    }

    public void broadcast(String eventName, Object body) {
        List<Subscriber> targets;
        synchronized (this) {
            targets = new ArrayList<>(subscribers);
        }
        String json = write(body);
        for (Subscriber subscriber : targets) {
            subscriber.send(eventName, json);
        }
    }

    public synchronized Set<Long> onlineIds() {
        Set<Long> ids = new HashSet<>();
        for (Subscriber subscriber : subscribers) {
            ids.add(subscriber.userId);
        }
        return ids;
    }

    public SseEmitter subscribe(long userId, Long afterId, Runnable onLeave) {
        SseEmitter emitter = new SseEmitter(TIMEOUT_MS);
        Subscriber subscriber = new Subscriber(userId, emitter);
        List<RoomNote> replay = new ArrayList<>();
        synchronized (this) {
            subscribers.add(subscriber);
            if (afterId != null && afterId >= 0) {
                for (RoomNote note : buffer) {
                    if (note.id() > afterId && note.visibleTo(userId)) {
                        replay.add(note);
                    }
                }
            }
        }
        Runnable detach = () -> {
            boolean last;
            synchronized (RoomHub.this) {
                subscribers.remove(subscriber);
                subscriber.closed = true;
                last = subscribers.stream().noneMatch(item -> item.userId == userId);
            }
            if (last) {
                onLeave.run();
            }
        };
        emitter.onCompletion(detach);
        emitter.onTimeout(detach);
        emitter.onError(error -> detach.run());
        for (RoomNote note : replay) {
            subscriber.send("message", write(note));
        }
        subscriber.heartbeat();
        log.debug("讨论室订阅 user={} afterId={}", userId, afterId);
        return emitter;
    }

    private String write(Object body) {
        try {
            return objectMapper.writeValueAsString(body);
        } catch (IOException ex) {
            throw new IllegalStateException("讨论室事件无法序列化", ex);
        }
    }

    private static final class Subscriber {
        private final long userId;
        private final SseEmitter emitter;
        private volatile boolean closed;

        private Subscriber(long userId, SseEmitter emitter) {
            this.userId = userId;
            this.emitter = emitter;
        }

        private void send(String eventName, String json) {
            if (closed) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().name(eventName).data(json, MediaType.TEXT_PLAIN));
            } catch (IOException | IllegalStateException ex) {
                closed = true;
            }
        }

        private void heartbeat() {
            Thread.startVirtualThread(() -> {
                while (!closed) {
                    try {
                        Thread.sleep(HEARTBEAT_MS);
                        if (closed) {
                            return;
                        }
                        emitter.send(SseEmitter.event().comment("ping"));
                    } catch (InterruptedException ex) {
                        Thread.currentThread().interrupt();
                        return;
                    } catch (IOException | IllegalStateException ex) {
                        closed = true;
                        return;
                    }
                }
            });
        }
    }
}
