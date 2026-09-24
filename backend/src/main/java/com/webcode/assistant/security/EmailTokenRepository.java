package com.webcode.assistant.security;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;

/**
 * email_tokens 表访问（邮箱验证 / 重置密码共用）。
 *
 * <p>这里的核心是 {@link #consume} 的原子性：改密码这种操作绝不能被重放，
 * 所以「校验」与「作废」必须在同一条 SQL 里完成 ——
 * 先查再改的两段式写法，在两个请求同时打进来时会让同一个链接生效两次。
 */
@Repository
public class EmailTokenRepository {

    public static final String PURPOSE_VERIFY_EMAIL = "VERIFY_EMAIL";
    public static final String PURPOSE_RESET_PASSWORD = "RESET_PASSWORD";

    private final JdbcClient jdbc;

    public EmailTokenRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** 作废该用户同类目的所有未用令牌，然后插入新的。 */
    public void issue(long userId, String tokenHash, String purpose, Instant expiresAt) {
        jdbc.sql("update email_tokens set consumed_at = now(6) "
                        + "where user_id = :u and purpose = :p and consumed_at is null")
                .param("u", userId)
                .param("p", purpose)
                .update();
        jdbc.sql("insert into email_tokens (user_id, token_hash, purpose, expires_at) "
                        + "values (:u, :h, :p, :e)")
                .param("u", userId)
                .param("h", tokenHash)
                .param("p", purpose)
                .param("e", Timestamp.from(expiresAt))
                .update();
    }

    /**
     * 校验并消费令牌，成功时返回所属 userId。
     *
     * <p>返回空的原因刻意不区分「不存在 / 过期 / 已用过 / 类目不对」——
     * 对攻击者来说这些信息的价值都一样，区分只会帮他缩小猜测范围。
     */
    public Optional<Long> consume(String tokenHash, String purpose) {
        Optional<Long> userId = jdbc.sql("select user_id from email_tokens "
                        + "where token_hash = :h and purpose = :p and consumed_at is null and expires_at > now(6)")
                .param("h", tokenHash)
                .param("p", purpose)
                .query(Long.class)
                .optional();
        if (userId.isEmpty()) {
            return Optional.empty();
        }
        int updated = jdbc.sql("update email_tokens set consumed_at = now(6) "
                        + "where token_hash = :h and consumed_at is null")
                .param("h", tokenHash)
                .update();
        // 并发下另一个请求抢先消费了：本次视为失败，不返回 userId
        return updated == 1 ? userId : Optional.empty();
    }

    /** 该用户最近一次签发某类令牌的时间，用于发送冷却。 */
    public Optional<Instant> lastIssuedAt(long userId, String purpose) {
        return jdbc.sql("select created_at from email_tokens "
                        + "where user_id = :u and purpose = :p order by id desc limit 1")
                .param("u", userId)
                .param("p", purpose)
                .query(Timestamp.class)
                .optional()
                .map(Timestamp::toInstant);
    }
}
