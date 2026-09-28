package com.webcode.assistant.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;

import com.webcode.assistant.config.AppProperties;

/**
 * JWT 签发与校验（HS256）。
 *
 * <p>选择 JWT 而非 Session：后端要预留给多个前端实例 / 后续拆分的可能，
 * 且无状态鉴权不需要额外的会话存储。
 */
@Service
public class JwtService {

    private final SecretKey key;
    private final AppProperties properties;

    public JwtService(AppProperties properties) {
        this.properties = properties;
        byte[] secret = properties.jwt().secret().getBytes(StandardCharsets.UTF_8);
        if (secret.length < 32) {
            throw new IllegalStateException("app.jwt.secret 至少需要 32 字节（256 bit），当前 " + secret.length + " 字节");
        }
        this.key = Keys.hmacShaKeyFor(secret);
    }

    /**
     * 签发 access token。
     *
     * <p>{@code epoch}（会话世代）写进令牌：它是签发那一刻 {@code users.token_epoch} 的值。
     * 之后任何「改密 / 强制下线 / 停用 / 降权」都会把库里的世代 +1，
     * 旧令牌携带的旧世代对不上新世代即被过滤器拒绝 —— 无状态令牌因此获得了
     * 「服务端一票否决」的能力，而代价只是每请求比对一个数字。
     */
    public String issue(long userId, String username, long epoch) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(Long.toString(userId))
                .claim("username", username)
                .claim("epoch", epoch)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(properties.jwt().ttl())))
                .signWith(key)
                .compact();
    }

    /** 解析失败一律返回空，由过滤器统一转成 401，不区分「过期」与「伪造」。 */
    public Optional<AppUserPrincipal> parse(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).build()
                    .parseSignedClaims(token)
                    .getPayload();
            long userId = Long.parseLong(claims.getSubject());
            String username = claims.get("username", String.class);
            // 用 Number 中转而不是 Long.class：小数值经 JSON 往返可能变成 Integer，
            // 直接按 Long.class 取会抛类型转换异常，把好令牌当成伪造令牌。
            Number epochClaim = claims.get("epoch", Number.class);
            long epoch = epochClaim == null ? 0L : epochClaim.longValue();
            return Optional.of(new AppUserPrincipal(userId, username, epoch));
        } catch (JwtException | IllegalArgumentException ex) {
            return Optional.empty();
        }
    }

    public long ttlSeconds() {
        return properties.jwt().ttl().toSeconds();
    }
}
