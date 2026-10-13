package com.webcode.assistant.room;

import java.time.Instant;

/** 讨论室里的一条消息。peerId 为空表示公屏。 */
public record RoomNote(
        long id,
        long senderId,
        String senderName,
        Long peerId,
        String body,
        String filePath,
        Instant createdAt
) {
    public boolean visibleTo(long userId) {
        return peerId == null || senderId == userId || peerId == userId;
    }
}
