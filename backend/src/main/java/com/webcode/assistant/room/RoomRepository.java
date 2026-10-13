package com.webcode.assistant.room;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class RoomRepository {

    private static final RowMapper<RoomNote> MAPPER = (rs, rowNum) -> new RoomNote(
            rs.getLong("id"),
            rs.getLong("sender_id"),
            rs.getString("username"),
            rs.getObject("peer_id") == null ? null : rs.getLong("peer_id"),
            rs.getString("body"),
            rs.getString("file_path"),
            rs.getTimestamp("created_at").toInstant());

    private final JdbcClient jdbc;

    public RoomRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(long senderId, Long peerId, String body, String filePath) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                        insert into room_messages (sender_id, peer_id, body, file_path)
                        values (:sender, :peer, :body, :path)
                        """)
                .param("sender", senderId)
                .param("peer", peerId)
                .param("body", body)
                .param("path", filePath)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 room_messages 后未能取回主键");
        }
        return id.longValue();
    }

    public RoomNote require(long id) {
        return jdbc.sql("""
                        select m.id, m.sender_id, u.username, m.peer_id, m.body, m.file_path, m.created_at
                        from room_messages m
                        join users u on u.id = m.sender_id
                        where m.id = :id
                        """)
                .param("id", id)
                .query(MAPPER)
                .optional()
                .orElseThrow(() -> new IllegalStateException("讨论消息不存在: " + id));
    }

    public List<RoomNote> recentPublic(int limit) {
        List<RoomNote> rows = jdbc.sql("""
                        select m.id, m.sender_id, u.username, m.peer_id, m.body, m.file_path, m.created_at
                        from room_messages m
                        join users u on u.id = m.sender_id
                        where m.peer_id is null
                        order by m.id desc
                        limit :limit
                        """)
                .param("limit", limit)
                .query(MAPPER)
                .list();
        return rows.reversed();
    }

    public List<RoomNote> recentDirect(long a, long b, int limit) {
        List<RoomNote> rows = jdbc.sql("""
                        select m.id, m.sender_id, u.username, m.peer_id, m.body, m.file_path, m.created_at
                        from room_messages m
                        join users u on u.id = m.sender_id
                        where (m.sender_id = :a and m.peer_id = :b)
                           or (m.sender_id = :b and m.peer_id = :a)
                        order by m.id desc
                        limit :limit
                        """)
                .param("a", a)
                .param("b", b)
                .param("limit", limit)
                .query(MAPPER)
                .list();
        return rows.reversed();
    }
}
