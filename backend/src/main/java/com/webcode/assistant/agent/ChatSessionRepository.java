package com.webcode.assistant.agent;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
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
        return jdbc.sql("""
                        insert into chat_sessions (workspace_id, user_id, title)
                        values (:workspaceId, :userId, :title)
                        returning id
                        """)
                .param("workspaceId", workspaceId)
                .param("userId", userId)
                .param("title", title)
                .query(Long.class)
                .single();
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

    public void touch(long sessionId) {
        jdbc.sql("update chat_sessions set updated_at = now() where id = :id")
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
