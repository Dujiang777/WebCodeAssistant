package com.webcode.assistant.agent;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * patches 表访问。
 */
@Repository
public class PatchRepository {

    private static final RowMapper<Patch> MAPPER = (rs, rowNum) -> new Patch(
            (UUID) rs.getObject("id"),
            rs.getLong("session_id"),
            (Long) rs.getObject("message_id"),
            rs.getString("file_path"),
            rs.getString("diff_text"),
            rs.getString("status"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("applied_at") == null ? null : rs.getTimestamp("applied_at").toInstant());

    private static final String COLUMNS =
            "id, session_id, message_id, file_path, diff_text, status, created_at, applied_at";

    private final JdbcClient jdbc;

    public PatchRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public UUID insert(long sessionId, Long messageId, String filePath, String diffText) {
        return jdbc.sql("""
                        insert into patches (session_id, message_id, file_path, diff_text, status)
                        values (:sessionId, :messageId, :filePath, :diffText, 'pending')
                        returning id
                        """)
                .param("sessionId", sessionId)
                .param("messageId", messageId)
                .param("filePath", filePath)
                .param("diffText", diffText)
                .query(UUID.class)
                .single();
    }

    public Optional<Patch> findById(UUID id) {
        return jdbc.sql("select " + COLUMNS + " from patches where id = :id")
                .param("id", id)
                .query(MAPPER)
                .optional();
    }

    public List<Patch> findBySession(long sessionId) {
        return jdbc.sql("select " + COLUMNS + " from patches where session_id = :sessionId order by id asc")
                .param("sessionId", sessionId)
                .query(MAPPER)
                .list();
    }

    /**
     * 带归属校验的读取：补丁 → 会话 → 用户。
     *
     * <p>补丁 uuid 本身不可枚举，但仍然再校验一次归属 —— 避免分享链接、
     * 或者将来某个接口只拿到 patchId 时出现越权。
     */
    public Optional<Patch> findOwned(UUID id, long userId) {
        return jdbc.sql("""
                        select p.id, p.session_id, p.message_id, p.file_path, p.diff_text,
                               p.status, p.created_at, p.applied_at
                          from patches p
                          join chat_sessions s on s.id = p.session_id
                         where p.id = :id and s.user_id = :userId
                        """)
                .param("id", id)
                .param("userId", userId)
                .query(MAPPER)
                .optional();
    }

    /**
     * 状态流转。
     *
     * <p>带 {@code status = 'pending'} 条件，保证「应用」与「拒绝」是幂等的竞争关系：
     * 两个请求同时到达时只有一个能改到状态，另一个拿到 0 行并被上层拒掉。
     */
    public boolean markResolved(UUID id, String status) {
        return jdbc.sql("""
                        update patches
                           set status = :status,
                               applied_at = case when :status = 'applied' then now() else applied_at end
                         where id = :id and status = 'pending'
                        """)
                .param("status", status)
                .param("id", id)
                .update() > 0;
    }

    public void attachMessage(UUID id, long messageId) {
        jdbc.sql("update patches set message_id = :messageId where id = :id and message_id is null")
                .param("messageId", messageId)
                .param("id", id)
                .update();
    }

    /** 落盘失败时把已认领的状态退回 pending，避免用户看到「已应用但文件没变」。 */
    public void revertToPending(UUID id) {
        jdbc.sql("update patches set status = 'pending', applied_at = null where id = :id")
                .param("id", id)
                .update();
    }
}
