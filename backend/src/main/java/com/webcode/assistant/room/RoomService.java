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
    private static final long MIN_GAP_MS = 400;

    private final RoomRepository repository;
    private final UserRepository users;
    private final RoomHub hub;
    private final Map<Long, Long> lastSent = new ConcurrentHashMap<>();

    public RoomService(RoomRepository repository, UserRepository users, RoomHub hub) {
        this.repository = repository;
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

    public List<UserRepository.UserBrief> people(long userId) {
        return users.listActiveExcept(userId, 80);
    }

    public RoomNote send(long userId, String username, Long peerId, String rawBody, String rawPath) {
        String body = rawBody == null ? "" : rawBody.trim();
        if (body.isEmpty() || body.length() > 1000) {
            throw ApiException.badRequest("消息要在 1 到 1000 字之间");
        }
        String path = rawPath == null ? "" : rawPath.trim();
        if (path.length() > 240 || path.indexOf('\n') >= 0 || path.indexOf('\r') >= 0) {
            throw ApiException.badRequest("文件路径不合法");
        }
        if (peerId != null) {
            requirePeer(userId, peerId);
        }
        long now = System.currentTimeMillis();
        Long previous = lastSent.put(userId, now);
        if (previous != null && now - previous < MIN_GAP_MS) {
            throw ApiException.badRequest("发得太快了，稍等一下");
        }
        long id = repository.insert(userId, peerId, body, path.isEmpty() ? null : path);
        RoomNote note = repository.require(id);
        // 用户名以库里为准，避免令牌里的旧名字和表不一致时前端对不上
        if (!username.equals(note.senderName())) {
            note = new RoomNote(note.id(), note.senderId(), note.senderName(), note.peerId(),
                    note.body(), note.filePath(), note.createdAt());
        }
        hub.publish(note);
        return note;
    }

    private void requirePeer(long userId, long peerId) {
        if (peerId == userId) {
            throw ApiException.badRequest("不能给自己发私聊");
        }
        users.findById(peerId).orElseThrow(() -> ApiException.notFound("对方不存在"));
    }
}
