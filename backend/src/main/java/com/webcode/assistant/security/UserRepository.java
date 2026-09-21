package com.webcode.assistant.security;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
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

    /** PostgreSQL 的 {@code returning} 让插入与取回自增主键一次完成。 */
    public long insert(String username, String passwordHash) {
        return jdbc.sql("insert into users (username, password_hash) values (:u, :p) returning id")
                .param("u", username)
                .param("p", passwordHash)
                .query(Long.class)
                .single();
    }
}
