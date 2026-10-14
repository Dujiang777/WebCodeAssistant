package com.webcode.assistant.room;

import java.time.Instant;

/** 讨论室里的一条消息。peerId 为空表示公屏。撤回后正文和代码都不再下发。 */
public record RoomNote(
        long id,
        long senderId,
        String senderName,
        Long peerId,
        String body,
        String filePath,
        String excerpt,
        Integer excerptStart,
        Integer excerptEnd,
        Instant createdAt,
        Long replyToId,
        String replyName,
        String replyPreview,
        boolean replyRetracted,
        boolean retracted,
        boolean edited
) {
    public boolean visibleTo(long userId) {
        return peerId == null || senderId == userId || peerId == userId;
    }
}
