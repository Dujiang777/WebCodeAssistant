package com.webcode.assistant.security;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * login_audit 表访问。
 *
 * <p>写入失败绝不能影响登录本身 —— 审计是旁路。所以调用方要忽略它的异常
 * （见 {@link AuthService} 里的 try/catch），这里则保持尽量简单。
 */
@Repository
public class LoginAuditRepository {

    public static final String REASON_BAD_PASSWORD = "BAD_PASSWORD";
    public static final String REASON_UNKNOWN_USER = "UNKNOWN_USER";
    public static final String REASON_LOCKED = "LOCKED";
    public static final String REASON_DISABLED = "DISABLED";

    private final JdbcClient jdbc;

    public LoginAuditRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void record(Long userId, String username, boolean success, String reason, String ip, String userAgent) {
        jdbc.sql("insert into login_audit (user_id, username, success, reason, ip, user_agent) "
                        + "values (:u, :n, :s, :r, :i, :a)")
                .param("u", userId)
                .param("n", truncate(username, 64))
                .param("s", success)
                .param("r", reason)
                .param("i", truncate(ip, 64))
                .param("a", truncate(userAgent, 255))
                .update();
    }

    /** 最近的失败次数，供管理端排查撞库。 */
    public long recentFailures(String username, int minutes) {
        return jdbc.sql("select count(*) from login_audit "
                        + "where username = :n and success = 0 "
                        + "and created_at > date_sub(now(6), interval :m minute)")
                .param("n", username)
                .param("m", minutes)
                .query(Long.class)
                .single();
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}
