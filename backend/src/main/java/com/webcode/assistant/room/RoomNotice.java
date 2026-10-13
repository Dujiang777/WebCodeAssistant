package com.webcode.assistant.room;

import java.time.Instant;

/** 某个账号的一条未读提醒。peerId 在私聊里是对方，公屏为空。 */
public record RoomNotice(
        long id,
        long userId,
        long messageId,
        String kind,
        long senderId,
        String senderName,
        String preview,
        Long peerId,
        Instant createdAt
) {
}
