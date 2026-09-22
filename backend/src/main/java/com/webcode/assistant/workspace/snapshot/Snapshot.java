package com.webcode.assistant.workspace.snapshot;

import java.time.Instant;
import java.util.UUID;

/**
 * 快照元数据（zip 实体在磁盘上，不进这个记录）。
 *
 * @param id        快照 id，同时是 zip 文件名
 * @param workspaceId 归属工作区
 * @param kind      auto = 应用补丁前自动打点；manual = 用户手动创建
 * @param label     给人看的说明（如「补丁应用前 · src/Main.java」）
 * @param patchId   触发快照的补丁（auto 时有值）
 * @param fileCount 快照内文件数
 * @param sizeBytes 快照 zip 字节数
 * @param createdAt 创建时间
 */
public record Snapshot(
        UUID id,
        long workspaceId,
        String kind,
        String label,
        UUID patchId,
        int fileCount,
        long sizeBytes,
        Instant createdAt) {

    public static final String KIND_AUTO = "auto";
    public static final String KIND_MANUAL = "manual";
}
