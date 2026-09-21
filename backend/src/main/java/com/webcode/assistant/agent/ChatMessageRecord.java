package com.webcode.assistant.agent;

import java.time.Instant;

/**
 * 消息读模型。
 *
 * @param role    {@code user} / {@code assistant} / {@code system} / {@code tool}
 * @param metaJson 结构化附加信息（工具轨迹、token 用量、引用文件），存 jsonb
 */
public record ChatMessageRecord(
        long id,
        long sessionId,
        String role,
        String content,
        String metaJson,
        Instant createdAt
) {

    public static final String ROLE_USER = "user";
    public static final String ROLE_ASSISTANT = "assistant";
}
