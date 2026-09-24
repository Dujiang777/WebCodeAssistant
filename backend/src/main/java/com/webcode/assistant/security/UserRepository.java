package com.webcode.assistant.security;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.Optional;

/**
 * users 表访问。使用 {@link JdbcClient} 手写 SQL —— 表结构简单，不需要引入 ORM。
 */
@Repository
public class UserRepository {

    private static final RowMapper<UserAccount> MAPPER = (rs, rowNum) -> new UserAccount(
            rs.getLong("id"),
            rs.getString("username"),
            rs.getString("password_hash"),
            rs.getTimestamp("created_at").toInstant());

    private static final String COLUMNS = "id, username, password_hash, created_at";

    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<UserAccount> findByUsername(String username) {
        return jdbc.sql("select " + COLUMNS + " from users where username = :u")
                .param("u", username)
                .query(MAPPER)
                .optional();
    }

    public Optional<UserAccount> findById(long id) {
        return jdbc.sql("select " + COLUMNS + " from users where id = :id")
                .param("id", id)
                .query(MAPPER)
                .optional();
    }

    public boolean existsByUsername(String username) {
        return jdbc.sql("select exists(select 1 from users where username = :u)")
                .param("u", username)
                .query(Boolean.class)
                .single();
    }

    /**
     * 插入并取回自增主键。
     *
     * <p>MySQL 没有 PostgreSQL 的 {@code returning}，改用 JDBC 的标准姿势：
     * 声明要取回生成键，由驱动把 {@code AUTO_INCREMENT} 的值回填进 {@link KeyHolder}。
     *
     * <p>刻意不写成「插完再查一次 {@code last_insert_id()}」—— 那个函数是**连接**作用域的，
     * 连接池里紧跟着的那条语句不保证落在同一个连接上，并发下会串号。
     */
    public long insert(String username, String passwordHash) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("insert into users (username, password_hash) values (:u, :p)")
                .param("u", username)
                .param("p", passwordHash)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 users 后未能取回自增主键");
        }
        return id.longValue();
    }
}
