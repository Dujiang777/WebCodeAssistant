package com.webcode.assistant.workspace.snapshot;

import com.webcode.assistant.common.Uuids;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * snapshots 表访问。
 *
 * <p>{@code id} 与可空的 {@code patch_id} 都是 {@code char(36)}，读写经 {@link Uuids} 转换。
 */
@Repository
public class SnapshotRepository {

    private static final RowMapper<Snapshot> MAPPER = (rs, rowNum) -> new Snapshot(
            Uuids.fromRaw(rs.getString("id")),
            rs.getLong("workspace_id"),
            rs.getString("kind"),
            rs.getString("label"),
            Uuids.fromRaw(rs.getString("patch_id")),
            rs.getInt("file_count"),
            rs.getLong("size_bytes"),
            rs.getTimestamp("created_at").toInstant());

    private static final String COLUMNS =
            "id, workspace_id, kind, label, patch_id, file_count, size_bytes, created_at";

    private final JdbcClient jdbc;

    public SnapshotRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** id 由调用方生成（zip 文件名与 DB 行必须同 id，否则回滚时找不到文件）。 */
    public UUID insert(UUID id, long workspaceId, long userId, String kind, String label,
                       UUID patchId, int fileCount, long sizeBytes) {
        jdbc.sql("""
                        insert into snapshots (id, workspace_id, user_id, kind, label, patch_id, file_count, size_bytes)
                        values (:id, :workspaceId, :userId, :kind, :label, :patchId, :fileCount, :sizeBytes)
                        """)
                .param("id", Uuids.toRaw(id))
                .param("workspaceId", workspaceId)
                .param("userId", userId)
                .param("kind", kind)
                .param("label", label)
                .param("patchId", Uuids.toRaw(patchId))
                .param("fileCount", fileCount)
                .param("sizeBytes", sizeBytes)
                .update();
        return id;
    }

    public Optional<Snapshot> findById(UUID id) {
        return jdbc.sql("select " + COLUMNS + " from snapshots where id = :id")
                .param("id", Uuids.toRaw(id))
                .query(MAPPER)
                .optional();
    }

    public List<Snapshot> findByWorkspace(long workspaceId) {
        return jdbc.sql("select " + COLUMNS + " from snapshots where workspace_id = :workspaceId order by created_at desc, id desc")
                .param("workspaceId", workspaceId)
                .query(MAPPER)
                .list();
    }

    public List<Snapshot> findAutoByWorkspace(long workspaceId) {
        return jdbc.sql("select " + COLUMNS + " from snapshots where workspace_id = :workspaceId and kind = 'auto' order by created_at desc, id desc")
                .param("workspaceId", workspaceId)
                .query(MAPPER)
                .list();
    }

    public void delete(UUID id) {
        jdbc.sql("delete from snapshots where id = :id")
                .param("id", Uuids.toRaw(id))
                .update();
    }
}
