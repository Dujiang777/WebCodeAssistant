package com.webcode.assistant.agent;

import com.webcode.assistant.common.Uuids;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * patches 表访问。
 *
 * <p>主键是 {@code char(36)} 的 UUID 字符串（MySQL 没有原生 uuid 类型），
 * 与 Java 侧的 {@link UUID} 之间由 {@link Uuids} 转换；id 在 Java 侧生成后
 * 显式写入，不依赖数据库默认值 —— 理由见 {@code V1__init.sql} 里的注释。
 */
@Repository
public class PatchRepository {

    private static final RowMapper<Patch> MAPPER = (rs, rowNum) -> new Patch(
            Uuids.fromRaw(rs.getString("id")),
            rs.getLong("session_id"),
            rs.getObject("message_id", Long.class),
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
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                        insert into patches (id, session_id, message_id, file_path, diff_text, status)
                        values (:id, :sessionId, :messageId, :filePath, :diffText, 'pending')
                        """)
                .param("id", Uuids.toRaw(id))
                .param("sessionId", sessionId)
                .param("messageId", messageId)
                .param("filePath", filePath)
                .param("diffText", diffText)
                .update();
        return id;
    }

    public Optional<Patch> findById(UUID id) {
        return jdbc.sql("select " + COLUMNS + " from patches where id = :id")
                .param("id", Uuids.toRaw(id))
                .query(MAPPER)
                .optional();
    }

    /**
     * 按创建顺序返回会话内的补丁。
     *
     * <p>排序键用 {@code created_at} 而不是主键：PostgreSQL 时代主键是原生 uuid，
     * 那里的 {@code order by id} 本来就是「随机顺序」；换成 char(36) 之后字符串序
     * 同样没有时间含义。既然要排，就按时间排。
     */
    public List<Patch> findBySession(long sessionId) {
        return jdbc.sql("select " + COLUMNS
                        + " from patches where session_id = :sessionId order by created_at asc, id asc")
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
                .param("id", Uuids.toRaw(id))
                .param("userId", userId)
                .query(MAPPER)
                .optional();
    }

    /**
     * 状态流转。
     *
     * <p>带 {@code status = 'pending'} 条件，保证「应用」与「拒绝」是幂等的竞争关系：
     * 两个请求同时到达时只有一个能改到状态，另一个拿到 0 行并被上层拒掉。
     *
     * <p>这里写 {@code current_timestamp(6)} 而不是更好看的 {@code now()}：MySQL 的
     * {@code now()} 不带参数时是**秒**精度（PostgreSQL 的 {@code now()} 是微秒），
     * 而列是 {@code datetime(6)} —— 用 {@code now()} 会把微秒抹成 .000000，
     * 于是「同一秒内应用的多个补丁」在按 applied_at 排序时失去先后。
     */
    public boolean markResolved(UUID id, String status) {
        return jdbc.sql("""
                        update patches
                           set status = :status,
                               applied_at = case when :status = 'applied' then current_timestamp(6) else applied_at end
                         where id = :id and status = 'pending'
                        """)
                .param("status", status)
                .param("id", Uuids.toRaw(id))
                .update() > 0;
    }

    public void attachMessage(UUID id, long messageId) {
        jdbc.sql("update patches set message_id = :messageId where id = :id and message_id is null")
                .param("messageId", messageId)
                .param("id", Uuids.toRaw(id))
                .update();
    }

    /** 落盘失败时把已认领的状态退回 pending，避免用户看到「已应用但文件没变」。 */
    public void revertToPending(UUID id) {
        jdbc.sql("update patches set status = 'pending', applied_at = null where id = :id")
                .param("id", Uuids.toRaw(id))
                .update();
    }
}
