package com.webcode.assistant.room;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public class RoomNoticeRepository {

    private static final RowMapper<RoomNotice> MAPPER = (rs, rowNum) -> new RoomNotice(
            rs.getLong("id"),
            rs.getLong("user_id"),
            rs.getLong("message_id"),
            rs.getString("kind"),
            rs.getLong("sender_id"),
            rs.getString("sender_name"),
            rs.getString("preview"),
            rs.getObject("peer_id") == null ? null : rs.getLong("peer_id"),
            rs.getTimestamp("created_at").toInstant());

    private final JdbcClient jdbc;

    public RoomNoticeRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public RoomNotice insert(long userId, RoomNote note, String kind) {
        String preview = note.body().length() > 180 ? note.body().substring(0, 180) : note.body();
        try {
            KeyHolder keys = new GeneratedKeyHolder();
            jdbc.sql("""
                            insert into room_notices
                                (user_id, message_id, kind, sender_id, sender_name, preview, peer_id)
                            values (:user, :message, :kind, :sender, :name, :preview, :peer)
                            """)
                    .param("user", userId)
                    .param("message", note.id())
                    .param("kind", kind)
                    .param("sender", note.senderId())
                    .param("name", note.senderName())
                    .param("preview", preview)
                    .param("peer", "DIRECT".equals(kind) ? note.senderId() : null)
                    .update(keys);
            Number id = keys.getKey();
            if (id == null) {
                throw new IllegalStateException("插入 room_notices 后未能取回主键");
            }
            return require(id.longValue());
        } catch (DuplicateKeyException ex) {
            return find(userId, note.id()).orElseThrow(() -> ex);
        }
    }

    public List<RoomNotice> unread(long userId, int limit) {
        return jdbc.sql("""
                        select id, user_id, message_id, kind, sender_id, sender_name, preview, peer_id, created_at
                        from room_notices
                        where user_id = :user and read_at is null
                        order by id desc
                        limit :limit
                        """)
                .param("user", userId)
                .param("limit", limit)
                .query(MAPPER)
                .list();
    }

    public int markRead(long userId, String kind, Long peerId) {
        if ("DIRECT".equals(kind)) {
            return jdbc.sql("""
                            update room_notices
                            set read_at = now(6)
                            where user_id = :user and read_at is null and kind = 'DIRECT' and sender_id = :peer
                            """)
                    .param("user", userId)
                    .param("peer", peerId)
                    .update();
        }
        return jdbc.sql("""
                        update room_notices
                        set read_at = now(6)
                        where user_id = :user and read_at is null and kind in ('PUBLIC', 'MENTION')
                        """)
                .param("user", userId)
                .update();
    }

    public int dropUnread(long messageId) {
        return jdbc.sql("""
                        delete from room_notices
                        where message_id = :message and read_at is null
                        """)
                .param("message", messageId)
                .update();
    }

    private RoomNotice require(long id) {
        return jdbc.sql("""
                        select id, user_id, message_id, kind, sender_id, sender_name, preview, peer_id, created_at
                        from room_notices where id = :id
                        """)
                .param("id", id)
                .query(MAPPER)
                .single();
    }

    private Optional<RoomNotice> find(long userId, long messageId) {
        return jdbc.sql("""
                        select id, user_id, message_id, kind, sender_id, sender_name, preview, peer_id, created_at
                        from room_notices where user_id = :user and message_id = :message
                        """)
                .param("user", userId)
                .param("message", messageId)
                .query(MAPPER)
                .optional();
    }
}
