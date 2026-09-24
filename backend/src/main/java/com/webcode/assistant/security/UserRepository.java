package com.webcode.assistant.security;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;

/**
 * users 表访问。使用 {@link JdbcClient} 手写 SQL —— 表结构简单，不需要引入 ORM。
 *
 * <p>两处刻意的写法：
 * <ul>
 *   <li><b>失败计数用一条 SQL 自增</b>（而不是「读出来 +1 再写回」）：
 *       撞库是并发的，读改写会丢计数，攻击者用并发请求就能让失败次数永远停在 1。</li>
 *   <li><b>时间戳显式包成 {@link Timestamp}</b>：MySQL 驱动对 {@code Instant} 的
 *       支持看版本和时区配置，包一层是没有代价的确定性写法。</li>
 * </ul>
 */
@Repository
public class UserRepository {

    private static final RowMapper<UserAccount> MAPPER = (rs, rowNum) -> new UserAccount(
            rs.getLong("id"),
            rs.getString("username"),
            rs.getString("email"),
            rs.getBoolean("email_verified"),
            rs.getString("password_hash"),
            rs.getString("role"),
            rs.getString("status"),
            rs.getInt("failed_attempts"),
            instantOrNull(rs.getTimestamp("locked_until")),
            instantOrNull(rs.getTimestamp("last_login_at")),
            instantOrNull(rs.getTimestamp("created_at")));

    private static final String COLUMNS =
            "id, username, email, email_verified, password_hash, role, status, "
                    + "failed_attempts, locked_until, last_login_at, created_at";

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

    public Optional<UserAccount> findByEmail(String email) {
        return jdbc.sql("select " + COLUMNS + " from users where email = :e")
                .param("e", email)
                .query(MAPPER)
                .optional();
    }

    public Optional<UserAccount> findById(long id) {
        return jdbc.sql("select " + COLUMNS + " from users where id = :id")
                .param("id", id)
                .query(MAPPER)
                .optional();
    }

    /**
     * 登录标识查找：一个输入框同时收用户名和邮箱。
     *
     * <p>用 {@code or} 而不是「先当用户名查、查不到再当邮箱查」：后者会让
     * 「用户名 x 存在但邮箱 x 不存在」这种输入多打一次库，而且两个条件本就可以合并。
     * 邮箱统一按小写存（见 {@code normalizeEmail}），所以这里直接等值比较。
     */
    public Optional<UserAccount> findByUsernameOrEmail(String identifier) {
        String lower = identifier == null ? "" : identifier.toLowerCase();
        return jdbc.sql("select " + COLUMNS + " from users where username = :i or email = :lower")
                .param("i", identifier)
                .param("lower", lower)
                .query(MAPPER)
                .optional();
    }

    public boolean existsByUsername(String username) {
        return jdbc.sql("select exists(select 1 from users where username = :u)")
                .param("u", username)
                .query(Boolean.class)
                .single();
    }

    public boolean existsByEmail(String email) {
        return jdbc.sql("select exists(select 1 from users where email = :e)")
                .param("e", email)
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
    public long insert(String username, String email, String passwordHash, String role) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("insert into users (username, email, password_hash, role) values (:u, :e, :p, :r)")
                .param("u", username)
                .param("e", email)
                .param("p", passwordHash)
                .param("r", role)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 users 后未能取回自增主键");
        }
        return id.longValue();
    }

    /** 登录成功：清空失败计数、解锁、记录登录时间。三条一起做，别留中间态给下一次登录。 */
    public void markLoginSuccess(long userId) {
        jdbc.sql("update users set failed_attempts = 0, locked_until = null, last_login_at = now(6) "
                        + "where id = :id")
                .param("id", userId)
                .update();
    }

    /**
     * 登录失败：计数 +1，并在达到阈值时直接落锁定时间。
     *
     * <p>「+1 后是否达阈值」的判断放在 SQL 里（{@code failed_attempts + 1 >= :max}），
     * 而不是先读出来判断 —— 与上面同样的理由：并发下读改写会丢计数。
     *
     * <p>注意这里用 {@code case when} 而不是无条件覆盖 {@code locked_until}：
     * 未达阈值时必须保留原有的锁定时间，否则「被锁后继续尝试」会把锁定期一次次刷新成
     * 新的时间戳，等于把 15 分钟变成无限长。
     */
    public void registerFailedAttempt(long userId, int maxAttempts, Instant lockUntil) {
        jdbc.sql("update users set failed_attempts = failed_attempts + 1, "
                        + "locked_until = case when failed_attempts + 1 >= :max then :lockUntil "
                        + "else locked_until end "
                        + "where id = :id")
                .param("max", maxAttempts)
                .param("lockUntil", Timestamp.from(lockUntil))
                .param("id", userId)
                .update();
    }

    public void markEmailVerified(long userId) {
        jdbc.sql("update users set email_verified = 1 where id = :id")
                .param("id", userId)
                .update();
    }

    public void updatePassword(long userId, String passwordHash) {
        jdbc.sql("update users set password_hash = :p, failed_attempts = 0, locked_until = null "
                        + "where id = :id")
                .param("p", passwordHash)
                .param("id", userId)
                .update();
    }

    /** 管理端：改角色 / 状态。 */
    public void updateRoleAndStatus(long userId, String role, String status) {
        jdbc.sql("update users set role = :r, status = :s where id = :id")
                .param("r", role)
                .param("s", status)
                .param("id", userId)
                .update();
    }

    private static Instant instantOrNull(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }
}
