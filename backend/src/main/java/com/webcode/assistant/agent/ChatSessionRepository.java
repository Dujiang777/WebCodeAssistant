package com.webcode.assistant.agent;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/**
 * chat_sessions 表访问。归属校验同样下推到 SQL。
 */
@Repository
public class ChatSessionRepository {

    private static final RowMapper<ChatSession> MAPPER = (rs, rowNum) -> new ChatSession(
            rs.getLong("id"),
            rs.getLong("workspace_id"),
            rs.getLong("user_id"),
            rs.getString("title"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("updated_at").toInstant());

    private static final String COLUMNS = "id, workspace_id, user_id, title, created_at, updated_at";

    private final JdbcClient jdbc;

    public ChatSessionRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(long workspaceId, long userId, String title) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                        insert into chat_sessions (workspace_id, user_id, title)
                        values (:workspaceId, :userId, :title)
                        """)
                .param("workspaceId", workspaceId)
                .param("userId", userId)
                .param("title", title)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 chat_sessions 后未能取回自增主键");
        }
        return id.longValue();
    }

    public Optional<ChatSession> findOwned(long sessionId, long userId) {
        return jdbc.sql("select " + COLUMNS + " from chat_sessions where id = :id and user_id = :userId")
                .param("id", sessionId)
                .param("userId", userId)
                .query(MAPPER)
                .optional();
    }

    public List<ChatSession> findAllByWorkspace(long workspaceId, long userId) {
        return jdbc.sql("select " + COLUMNS + " from chat_sessions "
                        + "where workspace_id = :workspaceId and user_id = :userId order by updated_at desc")
                .param("workspaceId", workspaceId)
                .param("userId", userId)
                .query(MAPPER)
                .list();
    }

    /**
     * 会话活跃时间戳。
     *
     * <p>用 {@code current_timestamp(6)} 而非 {@code now()}：MySQL 的 {@code now()} 是秒精度，
     * 而「最近会话」列表按 {@code updated_at desc} 排序 —— 同一秒内动过的两个会话会并列，
     * 排序就变成随机的。微秒精度让先后关系稳定。
     */
    public void touch(long sessionId) {
        jdbc.sql("update chat_sessions set updated_at = current_timestamp(6) where id = :id")
                .param("id", sessionId)
                .update();
    }

    public boolean deleteOwned(long sessionId, long userId) {
        return jdbc.sql("delete from chat_sessions where id = :id and user_id = :userId")
                .param("id", sessionId)
                .param("userId", userId)
                .update() > 0;
    }
}
