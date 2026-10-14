package com.webcode.assistant.room;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.security.UserRepository;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class RoomService {

    private static final int HISTORY = 80;
    private static final int PEOPLE = 200;
    private static final long MIN_GAP_MS = 400;

    private final RoomRepository repository;
    private final RoomNoticeRepository notices;
    private final UserRepository users;
    private final RoomHub hub;
    private final Map<Long, Long> lastSent = new ConcurrentHashMap<>();

    public RoomService(RoomRepository repository,
                       RoomNoticeRepository notices,
                       UserRepository users,
                       RoomHub hub) {
        this.repository = repository;
        this.notices = notices;
        this.users = users;
        this.hub = hub;
    }

    public List<RoomNote> history(long userId, Long peerId) {
        if (peerId == null) {
            return repository.recentPublic(HISTORY);
        }
        requirePeer(userId, peerId);
        return repository.recentDirect(userId, peerId, HISTORY);
    }

    public List<PersonPresence> people(long userId) {
        var online = hub.onlineIds();
        List<PersonPresence> rows = new java.util.ArrayList<>();
        for (UserRepository.UserBrief person : users.listActiveExcept(userId, PEOPLE)) {
            rows.add(new PersonPresence(person.id(), person.username(), online.contains(person.id())));
        }
        rows.sort((a, b) -> {
            if (a.online() != b.online()) {
                return a.online() ? -1 : 1;
            }
            return Long.compare(b.id(), a.id());
        });
        return rows;
    }

    public List<RoomNotice> notices(long userId) {
        return notices.unread(userId, 50);
    }

    public int markRead(long userId, String kind, Long peerId) {
        if (!"PUBLIC".equals(kind) && !"DIRECT".equals(kind)) {
            throw ApiException.badRequest("提醒类型不对");
        }
        if ("DIRECT".equals(kind) && peerId == null) {
            throw ApiException.badRequest("私聊提醒要带上对方");
        }
        return notices.markRead(userId, kind, peerId);
    }

    public org.springframework.web.servlet.mvc.method.annotation.SseEmitter open(long userId, String username, Long afterId) {
        var emitter = hub.subscribe(userId, afterId, () -> announce(userId, username, false));
        Thread.startVirtualThread(() -> {
            try {
                Thread.sleep(40);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return;
            }
            announce(userId, username, true);
        });
        return emitter;
    }

    public RoomNote send(long userId, Long peerId, String rawBody, String rawPath,
                         String rawExcerpt, Integer excerptStart, Integer excerptEnd) {
        String body = rawBody == null ? "" : rawBody.trim();
        if (body.isEmpty() || body.length() > 1000) {
            throw ApiException.badRequest("消息要在 1 到 1000 字之间");
        }
        String excerpt = rawExcerpt == null || rawExcerpt.isBlank() ? "" : rawExcerpt;
        if (excerpt.length() > 2000) {
            throw ApiException.badRequest("附上的代码不能超过 2000 字");
        }
        String path = rawPath == null ? "" : rawPath.trim();
        if (path.length() > 240 || path.indexOf('\n') >= 0 || path.indexOf('\r') >= 0) {
            throw ApiException.badRequest("文件路径不合法");
        }
        // 没有代码原文时，路径对别的工作区没有意义，不存
        if (excerpt.isEmpty()) {
            path = "";
            excerptStart = null;
            excerptEnd = null;
        } else if (excerptStart == null || excerptEnd == null || excerptStart < 1 || excerptEnd < excerptStart) {
            excerptStart = null;
            excerptEnd = null;
        }
        if (peerId != null) {
            requirePeer(userId, peerId);
        }
        long now = System.currentTimeMillis();
        Long previous = lastSent.put(userId, now);
        if (previous != null && now - previous < MIN_GAP_MS) {
            throw ApiException.badRequest("发得太快了，稍等一下");
        }
        long id = repository.insert(
                userId,
                peerId,
                body,
                path.isEmpty() ? null : path,
                excerpt.isEmpty() ? null : excerpt,
                excerptStart,
                excerptEnd);
        RoomNote note = repository.require(id);
        enqueue(userId, note);
        hub.publish(note);
        return note;
    }

    private void enqueue(long senderId, RoomNote note) {
        if (note.peerId() != null) {
            RoomNotice notice = notices.insert(note.peerId(), note, "DIRECT");
            hub.sendTo(note.peerId(), "notice", notice);
            return;
        }
        for (UserRepository.UserBrief person : users.listActiveExcept(senderId, PEOPLE)) {
            RoomNotice notice = notices.insert(person.id(), note, "PUBLIC");
            hub.sendTo(person.id(), "notice", notice);
        }
    }

    private void announce(long userId, String username, boolean online) {
        hub.broadcast("presence", new PersonPresence(userId, username, online));
    }

    public record PersonPresence(long id, String username, boolean online) {
    }

    private void requirePeer(long userId, long peerId) {
        if (peerId == userId) {
            throw ApiException.badRequest("不能给自己发私聊");
        }
        users.findById(peerId).orElseThrow(() -> ApiException.notFound("对方不存在"));
    }
}
