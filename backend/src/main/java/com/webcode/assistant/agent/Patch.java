package com.webcode.assistant.agent;

import java.time.Instant;
import java.util.UUID;

/**
 * 补丁读模型。
 *
 * @param id 对外暴露的补丁标识（uuid）。用 uuid 而非自增主键，既符合 SSE 事件契约，
 *           也避免通过遍历 id 拿到别人的补丁。
 * @param summary 模型生成补丁时写下的一句话变更说明（给用户看，中文）。
 *                可为 null —— 历史补丁与 What-if 等内部路径没有说明。
 */
public record Patch(
        UUID id,
        long sessionId,
        Long messageId,
        String filePath,
        String diffText,
        String summary,
        String status,
        Instant createdAt,
        Instant appliedAt
) {

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_APPLIED = "applied";
    public static final String STATUS_REJECTED = "rejected";
}
