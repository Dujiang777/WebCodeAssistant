package com.webcode.assistant.agent;

import java.time.Instant;

/** 会话读模型。 */
public record ChatSession(
        long id,
        long workspaceId,
        long userId,
        String title,
        Instant createdAt,
        Instant updatedAt
) {
}
