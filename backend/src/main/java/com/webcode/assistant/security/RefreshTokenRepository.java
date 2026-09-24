package com.webcode.assistant.security;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * refresh_tokens 表访问。
 *
 * <p>这张表存在的唯一理由是「撤销」：JWT 是无状态的，签发出去就收不回来。
 * 一旦把有效期拉长到 30 天，就必须有一个地方能说「这个令牌现在作废了」——
 * 改密码、点退出、发现异常登录，都要靠它。
 */
@Repository
public class RefreshTokenRepository {

    /** 登录设备列表用的行视图。刻意不含 token_hash —— 下发给前端的东西里不该有它。 */
    public record RefreshTokenRow(long id, String device, String ip, Instant expiresAt, Instant createdAt) {
    }

    /** 校验用行视图：带上 token_hash，供「重放检测」顺着轮换链处理。 */
    public record TokenState(long id, long userId, Instant expiresAt, Instant revokedAt, String replacedBy) {
    }

    private final JdbcClient jdbc;

    public RefreshTokenRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(long userId, String tokenHash, String device, String ip, Instant expiresAt) {
        jdbc.sql("insert into refresh_tokens (user_id, token_hash, device, ip, expires_at) "
                        + "values (:u, :h, :d, :i, :e)")
                .param("u", userId)
                .param("h", tokenHash)
                .param("d", device)
                .param("i", ip)
                .param("e", Timestamp.from(expiresAt))
                .update();
    }

    public Optional<TokenState> find(String tokenHash) {
        return jdbc.sql("select id, user_id, expires_at, revoked_at, replaced_by "
                        + "from refresh_tokens where token_hash = :h")
                .param("h", tokenHash)
                .query((rs, rowNum) -> new TokenState(
                        rs.getLong("id"),
                        rs.getLong("user_id"),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("revoked_at") == null ? null : rs.getTimestamp("revoked_at").toInstant(),
                        rs.getString("replaced_by")))
                .optional();
    }

    /** 撤销单个令牌，并记下「被谁替代」，形成轮换链。 */
    public void revoke(String tokenHash, String replacedBy) {
        jdbc.sql("update refresh_tokens set revoked_at = now(6), replaced_by = :r "
                        + "where token_hash = :h and revoked_at is null")
                .param("r", replacedBy)
                .param("h", tokenHash)
                .update();
    }

    /** 撤销该用户全部令牌：改密码、发现重放、管理员停用账号时调用。 */
    public int revokeAll(long userId) {
        return jdbc.sql("update refresh_tokens set revoked_at = now(6) "
                        + "where user_id = :u and revoked_at is null")
                .param("u", userId)
                .update();
    }

    /** 撤销某个设备（按 id，且必须是本人的，避免越权吊销别人的会话）。 */
    public int revokeOne(long userId, long id) {
        return jdbc.sql("update refresh_tokens set revoked_at = now(6) "
                        + "where id = :id and user_id = :u and revoked_at is null")
                .param("id", id)
                .param("u", userId)
                .update();
    }

    public List<RefreshTokenRow> listActive(long userId) {
        return jdbc.sql("select id, device, ip, expires_at, created_at from refresh_tokens "
                        + "where user_id = :u and revoked_at is null and expires_at > now(6) "
                        + "order by id desc limit 50")
                .param("u", userId)
                .query((rs, rowNum) -> new RefreshTokenRow(
                        rs.getLong("id"),
                        rs.getString("device"),
                        rs.getString("ip"),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("created_at").toInstant()))
                .list();
    }
}
