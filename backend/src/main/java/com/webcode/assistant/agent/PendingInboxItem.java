package com.webcode.assistant.agent;

import java.time.Instant;
import java.util.UUID;

/** 工作区里一张待确认补丁，带它所在的会话名。 */
public record PendingInboxItem(
        UUID id,
        long sessionId,
        String sessionTitle,
        String filePath,
        String summary,
        Instant createdAt
) {
}
