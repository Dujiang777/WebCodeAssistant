package com.webcode.assistant.room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * 讨论室的实时通道。历史走 REST，这里只推新消息，并在重连时按消息 id 补发。
 * 私聊只发给双方。
 */
@Component
public class RoomHub {

    private static final Logger log = LoggerFactory.getLogger(RoomHub.class);
    private static final int BUFFER = 400;
    private static final long TIMEOUT_MS = 30 * 60 * 1000L;
    private static final long HEARTBEAT_MS = 15_000L;

    private final ObjectMapper objectMapper;
    private final Deque<RoomNote> buffer = new ArrayDeque<>();
    private final List<Subscriber> subscribers = new ArrayList<>();

    public RoomHub(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public synchronized void publish(RoomNote note) {
        while (buffer.size() >= BUFFER) {
            buffer.removeFirst();
        }
        buffer.addLast(note);
        for (Subscriber subscriber : new ArrayList<>(subscribers)) {
            if (note.visibleTo(subscriber.userId)) {
                subscriber.send(note);
            }
        }
    }

    public synchronized SseEmitter subscribe(long userId, Long afterId) {
        SseEmitter emitter = new SseEmitter(TIMEOUT_MS);
        Subscriber subscriber = new Subscriber(userId, emitter, objectMapper);
        subscribers.add(subscriber);
        Runnable detach = () -> {
            synchronized (RoomHub.this) {
                subscribers.remove(subscriber);
            }
            subscriber.closed = true;
        };
        emitter.onCompletion(detach);
        emitter.onTimeout(detach);
        emitter.onError(error -> detach.run());
        if (afterId != null && afterId >= 0) {
            for (RoomNote note : buffer) {
                if (note.id() > afterId && note.visibleTo(userId)) {
                    subscriber.send(note);
                }
            }
        }
        subscriber.heartbeat();
        log.debug("讨论室订阅 user={} afterId={}", userId, afterId);
        return emitter;
    }

    private static final class Subscriber {
        private final long userId;
        private final SseEmitter emitter;
        private final ObjectMapper objectMapper;
        private volatile boolean closed;

        private Subscriber(long userId, SseEmitter emitter, ObjectMapper objectMapper) {
            this.userId = userId;
            this.emitter = emitter;
            this.objectMapper = objectMapper;
        }

        private void send(RoomNote note) {
            if (closed) return;
            try {
                emitter.send(SseEmitter.event()
                        .name("message")
                        .data(objectMapper.writeValueAsString(note)));
            } catch (IOException | IllegalStateException ex) {
                closed = true;
                emitter.complete();
            }
        }

        private void heartbeat() {
            Thread.startVirtualThread(() -> {
                while (!closed) {
                    try {
                        Thread.sleep(HEARTBEAT_MS);
                        if (closed) return;
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
