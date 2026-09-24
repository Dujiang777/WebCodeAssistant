package com.webcode.assistant.agent;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * chat_messages 表访问。
 *
 * <p>{@code meta} 列是 MySQL 的 {@code json} 类型，但这里两端都当**字符串**处理：
 * 写入时直接绑 JSON 文本（数据库会解析校验，非法 JSON 会当场报错而不是悄悄存进去），
 * 读取时取字符串交给 Jackson —— 避免为了一个字段引入 ORM 的类型映射。
 */
@Repository
public class ChatMessageRepository {

    private static final RowMapper<ChatMessageRecord> MAPPER = (rs, rowNum) -> new ChatMessageRecord(
            rs.getLong("id"),
            rs.getLong("session_id"),
            rs.getString("role"),
            rs.getString("content"),
            rs.getString("meta"),
            rs.getTimestamp("created_at").toInstant());

    private static final String COLUMNS = "id, session_id, role, content, meta, created_at";

    private final JdbcClient jdbc;

    public ChatMessageRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(long sessionId, String role, String content, String metaJson) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                        insert into chat_messages (session_id, role, content, meta)
                        values (:sessionId, :role, :content, :meta)
                        """)
                .param("sessionId", sessionId)
                .param("role", role)
                .param("content", content == null ? "" : content)
                .param("meta", metaJson == null || metaJson.isBlank() ? "{}" : metaJson)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 chat_messages 后未能取回自增主键");
        }
        return id.longValue();
    }

    /** 按时间正序返回整段会话历史（前端渲染用）。 */
    public List<ChatMessageRecord> findBySession(long sessionId) {
        return jdbc.sql("select " + COLUMNS + " from chat_messages where session_id = :sessionId order by id asc")
                .param("sessionId", sessionId)
                .query(MAPPER)
                .list();
    }

    /**
     * 取最近 N 条用于组装模型上下文。
     *
     * <p>先按 id 倒序取 N 条、再在内存里翻转，避免一次性把长会话全部读进内存。
     */
    public List<ChatMessageRecord> findRecent(long sessionId, int limit) {
        List<ChatMessageRecord> recent = jdbc.sql("select " + COLUMNS
                        + " from chat_messages where session_id = :sessionId order by id desc limit :limit")
                .param("sessionId", sessionId)
                .param("limit", limit)
                .query(MAPPER)
                .list();
        return recent.reversed();
    }

    public long countBySession(long sessionId) {
        return jdbc.sql("select count(*) from chat_messages where session_id = :sessionId")
                .param("sessionId", sessionId)
                .query(Long.class)
                .single();
    }
}
