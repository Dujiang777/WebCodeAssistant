package com.webcode.assistant.workspace;

import java.time.Instant;

/**
 * 工作区读模型。{@code rootPath} 是服务器磁盘上的绝对路径，天然不该下发给前端，
 * 由 API 层的 DTO 决定只暴露 {@code name} 与 {@code id}。
 */
public record Workspace(
        long id,
        long userId,
        String name,
        String rootPath,
        String gitUrl,
        long sizeBytes,
        Instant createdAt
) {
}
