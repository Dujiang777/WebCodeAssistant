package com.webcode.assistant.room;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class RoomRepository {

    private static final String SELECT_NOTE = """
            select m.id, m.sender_id, u.username, m.peer_id, m.body, m.file_path,
                   m.excerpt, m.excerpt_start, m.excerpt_end, m.created_at,
                   m.reply_to_id, m.retracted_at,
                   ru.username as reply_name,
                   case
                       when r.id is null or r.retracted_at is not null then null
                       when r.body is null or r.body = '' then left(coalesce(r.excerpt, ''), 80)
                       else left(r.body, 80)
                   end as reply_preview,
                   case when r.retracted_at is null then 0 else 1 end as reply_retracted
            from room_messages m
            join users u on u.id = m.sender_id
            left join room_messages r on r.id = m.reply_to_id
            left join users ru on ru.id = r.sender_id
            """;

    private static final RowMapper<RoomNote> MAPPER = (rs, rowNum) -> {
        boolean retracted = rs.getTimestamp("retracted_at") != null;
        Long replyToId = rs.getObject("reply_to_id") == null ? null : rs.getLong("reply_to_id");
        return new RoomNote(
                rs.getLong("id"),
                rs.getLong("sender_id"),
                rs.getString("username"),
                rs.getObject("peer_id") == null ? null : rs.getLong("peer_id"),
                retracted ? "" : rs.getString("body"),
                retracted ? null : rs.getString("file_path"),
                retracted ? null : rs.getString("excerpt"),
                retracted || rs.getObject("excerpt_start") == null ? null : rs.getInt("excerpt_start"),
                retracted || rs.getObject("excerpt_end") == null ? null : rs.getInt("excerpt_end"),
                rs.getTimestamp("created_at").toInstant(),
                replyToId,
                replyToId == null ? null : rs.getString("reply_name"),
                replyToId == null ? null : rs.getString("reply_preview"),
                replyToId != null && rs.getInt("reply_retracted") == 1,
                retracted);
    };

    private static final RowMapper<ThreadHead> THREADS = (rs, rowNum) -> new ThreadHead(
            rs.getLong("other_id"),
            rs.getString("username"),
            rs.getLong("last_id"),
            rs.getString("body"),
            rs.getString("excerpt"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("retracted_at") != null,
            rs.getInt("unread"));

    private final JdbcClient jdbc;

    public RoomRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(long senderId, Long peerId, Long replyToId, String body, String filePath,
                       String excerpt, Integer excerptStart, Integer excerptEnd) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                        insert into room_messages
                            (sender_id, peer_id, reply_to_id, body, file_path, excerpt, excerpt_start, excerpt_end)
                        values (:sender, :peer, :reply, :body, :path, :excerpt, :start, :end)
                        """)
                .param("sender", senderId)
                .param("peer", peerId)
                .param("reply", replyToId)
                .param("body", body)
                .param("path", filePath)
                .param("excerpt", excerpt)
                .param("start", excerptStart)
                .param("end", excerptEnd)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 room_messages 后未能取回主键");
        }
        return id.longValue();
    }

    public Optional<RoomNote> find(long id) {
        return jdbc.sql(SELECT_NOTE + " where m.id = :id")
                .param("id", id)
                .query(MAPPER)
                .optional();
    }

    public RoomNote require(long id) {
        return find(id).orElseThrow(() -> new IllegalStateException("讨论消息不存在: " + id));
    }

    public boolean retract(long id, long senderId) {
        int updated = jdbc.sql("""
                        update room_messages
                        set body = '',
                            file_path = null,
                            excerpt = null,
                            excerpt_start = null,
                            excerpt_end = null,
                            retracted_at = now(6)
                        where id = :id and sender_id = :sender and retracted_at is null
                        """)
                .param("id", id)
                .param("sender", senderId)
                .update();
        return updated > 0;
    }

    public List<RoomNote> pagePublic(long beforeId, int limit) {
        return reversed(jdbc.sql(SELECT_NOTE + """
                        where m.peer_id is null and m.id < :before
                        order by m.id desc
                        limit :limit
                        """)
                .param("before", beforeId)
                .param("limit", limit)
                .query(MAPPER)
                .list());
    }

    public List<RoomNote> pageDirect(long a, long b, long beforeId, int limit) {
        return reversed(jdbc.sql(SELECT_NOTE + """
                        where m.id < :before
                          and ((m.sender_id = :a and m.peer_id = :b) or (m.sender_id = :b and m.peer_id = :a))
                        order by m.id desc
                        limit :limit
                        """)
                .param("before", beforeId)
                .param("a", a)
                .param("b", b)
                .param("limit", limit)
                .query(MAPPER)
                .list());
    }

    public List<RoomNote> searchPublic(String like, int limit) {
        return reversed(jdbc.sql(SELECT_NOTE + """
                        where m.peer_id is null
                          and m.retracted_at is null
                          and (m.body like :q escape '\\\\' or m.excerpt like :q escape '\\\\')
                        order by m.id desc
                        limit :limit
                        """)
                .param("q", like)
                .param("limit", limit)
                .query(MAPPER)
                .list());
    }

    public List<RoomNote> searchDirect(long a, long b, String like, int limit) {
        return reversed(jdbc.sql(SELECT_NOTE + """
                        where m.retracted_at is null
                          and ((m.sender_id = :a and m.peer_id = :b) or (m.sender_id = :b and m.peer_id = :a))
                          and (m.body like :q escape '\\\\' or m.excerpt like :q escape '\\\\')
                        order by m.id desc
                        limit :limit
                        """)
                .param("a", a)
                .param("b", b)
                .param("q", like)
                .param("limit", limit)
                .query(MAPPER)
                .list());
    }

    public List<ThreadHead> threads(long userId, int limit) {
        return jdbc.sql("""
                        select t.other_id, u.username, m.id as last_id, m.body, m.excerpt, m.created_at, m.retracted_at,
                               (select count(*) from room_notices n
                                 where n.user_id = :me and n.read_at is null and n.kind = 'DIRECT' and n.sender_id = t.other_id) as unread
                        from (
                            select case when sender_id = :me then peer_id else sender_id end as other_id,
                                   max(id) as last_id
                            from room_messages
                            where peer_id is not null and (sender_id = :me or peer_id = :me)
                            group by case when sender_id = :me then peer_id else sender_id end
                        ) t
                        join room_messages m on m.id = t.last_id
                        join users u on u.id = t.other_id
                        order by m.id desc
                        limit :limit
                        """)
                .param("me", userId)
                .param("limit", limit)
                .query(THREADS)
                .list();
    }

    private static List<RoomNote> reversed(List<RoomNote> rows) {
        return rows.reversed();
    }

    public record ThreadHead(
            long peerId,
            String username,
            long lastId,
            String body,
            String excerpt,
            Instant lastAt,
            boolean retracted,
            int unread
    ) {
    }
}
