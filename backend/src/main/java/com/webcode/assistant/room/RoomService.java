package com.webcode.assistant.room;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.security.UserRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class RoomService {

    private static final int HISTORY = 80;
    private static final int PEOPLE = 200;
    private static final int THREADS = 40;
    private static final int SEARCH = 40;
    private static final int MENTION_CAP = 8;
    private static final long MIN_GAP_MS = 400;
    private static final long OPEN_BEFORE = Long.MAX_VALUE;
    private static final Pattern MENTION = Pattern.compile("(?<![A-Za-z0-9_.-])@([A-Za-z0-9_.-]{3,64})");

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

    public List<RoomNote> history(long userId, Long peerId, Long beforeId) {
        long before = before(beforeId);
        if (peerId == null) {
            return repository.pagePublic(before, HISTORY);
        }
        requirePeer(userId, peerId);
        return repository.pageDirect(userId, peerId, before, HISTORY);
    }

    public List<RoomNote> search(long userId, Long peerId, String rawQuery) {
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.isEmpty() || query.length() > 40) {
            throw ApiException.badRequest("搜索词要在 1 到 40 字之间");
        }
        String like = like(query);
        if (peerId == null) {
            return repository.searchPublic(like, SEARCH);
        }
        requirePeer(userId, peerId);
        return repository.searchDirect(userId, peerId, like, SEARCH);
    }

    public List<RoomThread> threads(long userId) {
        var online = hub.onlineIds();
        List<RoomThread> rows = new ArrayList<>();
        for (RoomRepository.ThreadHead head : repository.threads(userId, THREADS)) {
            rows.add(new RoomThread(
                    head.peerId(),
                    head.username(),
                    online.contains(head.peerId()),
                    head.lastId(),
                    preview(head),
                    head.lastAt(),
                    head.unread()));
        }
        return rows;
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

    public RoomNote send(long userId, Long peerId, Long replyToId, String rawBody, String rawPath,
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
        if (replyToId != null) {
            requireReply(userId, peerId, replyToId);
        }
        long now = System.currentTimeMillis();
        Long previous = lastSent.put(userId, now);
        if (previous != null && now - previous < MIN_GAP_MS) {
            throw ApiException.badRequest("发得太快了，稍等一下");
        }
        long id = repository.insert(
                userId,
                peerId,
                replyToId,
                body,
                path.isEmpty() ? null : path,
                excerpt.isEmpty() ? null : excerpt,
                excerptStart,
                excerptEnd);
        RoomNote note = repository.require(id);
        enqueue(userId, note, peerId == null ? mentionedIds(body, userId) : Set.of());
        hub.publish(note);
        return note;
    }

    public RoomNote retract(long userId, long messageId) {
        RoomNote note = repository.find(messageId).orElseThrow(() -> ApiException.notFound("消息不存在"));
        if (!note.visibleTo(userId)) {
            throw ApiException.notFound("消息不存在");
        }
        if (note.senderId() != userId) {
            throw ApiException.forbidden("只能撤回自己的消息");
        }
        if (!note.retracted() && repository.retract(messageId, userId)) {
            notices.dropUnread(messageId);
            note = repository.require(messageId);
            hub.publish(note);
        }
        return note;
    }

    private void enqueue(long senderId, RoomNote note, Set<Long> mentioned) {
        if (note.peerId() != null) {
            RoomNotice notice = notices.insert(note.peerId(), note, "DIRECT");
            hub.sendTo(note.peerId(), "notice", notice);
            return;
        }
        Set<Long> seen = new LinkedHashSet<>();
        for (UserRepository.UserBrief person : users.listActiveExcept(senderId, PEOPLE)) {
            String kind = mentioned.contains(person.id()) ? "MENTION" : "PUBLIC";
            RoomNotice notice = notices.insert(person.id(), note, kind);
            hub.sendTo(person.id(), "notice", notice);
            seen.add(person.id());
        }
        for (Long id : mentioned) {
            if (seen.contains(id)) {
                continue;
            }
            RoomNotice notice = notices.insert(id, note, "MENTION");
            hub.sendTo(id, "notice", notice);
        }
    }

    private Set<Long> mentionedIds(String body, long senderId) {
        Matcher matcher = MENTION.matcher(body);
        Set<String> names = new LinkedHashSet<>();
        while (matcher.find() && names.size() < MENTION_CAP) {
            names.add(matcher.group(1));
        }
        Set<Long> ids = new LinkedHashSet<>();
        for (String name : names) {
            users.findByUsername(name)
                    .filter(account -> account.active() && account.id() != senderId)
                    .ifPresent(account -> ids.add(account.id()));
        }
        return ids;
    }

    private void requireReply(long userId, Long peerId, long replyToId) {
        RoomNote target = repository.find(replyToId).orElseThrow(() -> ApiException.badRequest("回复的消息不存在"));
        if (!target.visibleTo(userId)) {
            throw ApiException.badRequest("不能回复这条消息");
        }
        boolean samePublic = peerId == null && target.peerId() == null;
        boolean sameDirect = peerId != null && target.peerId() != null && target.visibleTo(peerId) && target.visibleTo(userId)
                && (target.senderId() == peerId || target.peerId() == peerId);
        if (!samePublic && !sameDirect) {
            throw ApiException.badRequest("只能回复当前这段对话里的消息");
        }
    }

    private static long before(Long beforeId) {
        if (beforeId == null) {
            return OPEN_BEFORE;
        }
        if (beforeId < 1) {
            throw ApiException.badRequest("历史位置不对");
        }
        return beforeId;
    }

    private static String like(String query) {
        return "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    private static String preview(RoomRepository.ThreadHead head) {
        if (head.retracted()) {
            return "已撤回";
        }
        String text = head.body() == null ? "" : head.body().trim();
        boolean code = head.excerpt() != null && !head.excerpt().isBlank();
        if (text.isEmpty()) {
            return code ? "附带一段代码" : "";
        }
        String clipped = text.length() > 80 ? text.substring(0, 80) : text;
        return code ? "代码 · " + clipped : clipped;
    }

    private void announce(long userId, String username, boolean online) {
        hub.broadcast("presence", new PersonPresence(userId, username, online));
    }

    public record PersonPresence(long id, String username, boolean online) {
    }

    public record RoomThread(
            long peerId,
            String username,
            boolean online,
            long lastId,
            String preview,
            Instant lastAt,
            int unread
    ) {
    }

    private void requirePeer(long userId, long peerId) {
        if (peerId == userId) {
            throw ApiException.badRequest("不能给自己发私聊");
        }
        users.findById(peerId).orElseThrow(() -> ApiException.notFound("对方不存在"));
    }
}
