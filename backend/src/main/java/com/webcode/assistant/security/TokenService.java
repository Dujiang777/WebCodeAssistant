package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.common.Tokens;
import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * 令牌签发 / 轮换 / 撤销。
 *
 * <p>双令牌的分工：
 * <ul>
 *   <li><b>access token</b>：JWT，2 小时，不落库。每个请求都带，走内存验签，零 IO。</li>
 *   <li><b>refresh token</b>：随机串，30 天，只存 sha256 摘要。只在续期时用，
 *       能撤销、能轮换、能看到「登录了几台设备」。</li>
 * </ul>
 *
 * <p><b>轮换 + 重放检测</b>是这套设计真正的价值所在：每次刷新都换一对新令牌，
 * 旧 refresh 立刻作废并记下「被谁替代」。如果某个<b>被轮换掉</b>的 refresh 又被拿来用，
 * 只有两种可能 —— 要么令牌被复制走了，要么客户端实现有 bug。分不清，
 * 所以按最坏情况处理：把该用户所有会话全部吊销，强制重新登录。
 * 这是 Auth0 / Okta 这类系统的标准做法，宁可误伤也不能放过。
 *
 * <p>但「已作废」不等于「被轮换」：那只对 {@code replacedBy} 非空的情况成立。
 * 被「退出登录 / 改密码」正常作废的令牌被重试是日常现象，只拒绝这一次 ——
 * 否则任何拿到过历史令牌的人都能免鉴权地把用户从所有设备上踢下去。详见 {@link #rotate}。
 */
@Service
public class TokenService {

    private static final Logger log = LoggerFactory.getLogger(TokenService.class);

    private final JwtService jwtService;
    private final RefreshTokenRepository refreshTokenRepository;
    private final UserRepository userRepository;
    /** 紧急吊销走独立事务 —— 这里要抛异常，同一事务里的吊销会被回滚掉，详见该类注释。 */
    private final SessionRevoker sessionRevoker;
    private final AppProperties properties;

    public TokenService(JwtService jwtService,
                        RefreshTokenRepository refreshTokenRepository,
                        UserRepository userRepository,
                        SessionRevoker sessionRevoker,
                        AppProperties properties) {
        this.jwtService = jwtService;
        this.refreshTokenRepository = refreshTokenRepository;
        this.userRepository = userRepository;
        this.sessionRevoker = sessionRevoker;
        this.properties = properties;
    }

    /** 一次登录 / 注册返回的令牌对。 */
    public record IssuedTokens(String accessToken, long accessExpiresInSeconds,
                               String refreshToken, long refreshExpiresInSeconds) {
    }

    /**
     * 轮换结果。
     *
     * <p>刻意带上 {@code userId}：调用方（AuthService）拿到新令牌后还要查一遍账号状态
     * （角色可能刚被改、账号可能刚被停用），而 userId 只有校验完 refresh 才知道。
     * 让 rotate 把它带出来，比在 AuthService 里再解析一次 JWT 干净得多。
     */
    public record Rotated(long userId, IssuedTokens tokens) {
    }

    @Transactional
    public IssuedTokens issue(long userId, String username, String device, String ip) {
        Instant refreshExpiry = Instant.now().plus(properties.jwt().refreshTtl());
        String rawRefresh = Tokens.newRaw();
        refreshTokenRepository.insert(userId, Tokens.hash(rawRefresh), device, ip, refreshExpiry);
        return new IssuedTokens(
                jwtService.issue(userId, username),
                jwtService.ttlSeconds(),
                rawRefresh,
                properties.jwt().refreshTtl().toSeconds());
    }

    /**
     * 用 refresh 换一对新令牌（轮换）。
     *
     * @throws ApiException 令牌缺失 / 无效 / 过期 / 重放时抛 401，调用方让用户重新登录
     */
    @Transactional
    public Rotated rotate(String rawRefresh, String device, String ip) {
        if (rawRefresh == null || rawRefresh.isBlank()) {
            throw new ApiException(ErrorCode.TOKEN_INVALID, "缺少刷新令牌，请重新登录");
        }
        String hash = Tokens.hash(rawRefresh);
        RefreshTokenRepository.TokenState state = refreshTokenRepository.find(hash)
                .orElseThrow(() -> new ApiException(ErrorCode.TOKEN_INVALID, "刷新令牌无效，请重新登录"));

        if (state.revokedAt() != null) {
            // 已作废的令牌又被用了 —— 但「作废原因」决定了该怎么反应，二者不能混为一谈：
            //
            //   1) replacedBy 非空 = 这个令牌是被**轮换**掉的。同一个令牌在客户端手里
            //      却又换过一次新令牌，只有两种可能：令牌被复制走了，或客户端实现有 bug。
            //      分不清，按最坏情况处理 —— 全量吊销，这是 Auth0/Okta 的标准动作。
            //
            //   2) replacedBy 为空 = 它是被「退出登录 / 改密码 / 重置密码」正常作废的。
            //      这种令牌被重试是**日常现象**（老客户端还揣着它、用户换设备后旧页面还在跑），
            //      只拒绝这一次就够了。如果这里也全量吊销，就等于给了任何人一个
            //      免鉴权的踢人开关：拿一个历史上早就作废的令牌反复请求，
            //      能把正在使用的用户从所有设备上踢下去 —— 这是自伤式 DoS。
            if (state.replacedBy() != null) {
                // 必须用 SessionRevoker（独立事务）：这里紧接着要抛异常，
                // 若把吊销写在当前事务里，它会跟着一起回滚 —— 看起来把用户踢了，
                // 实际被复制走的那对令牌全都还活着。
                int revoked = sessionRevoker.revokeAll(state.userId());
                log.warn("检测到刷新令牌重放，已吊销该用户全部会话 userId={} 吊销数={}",
                        state.userId(), revoked);
                throw new ApiException(ErrorCode.TOKEN_INVALID, "登录状态异常，已为你安全退出，请重新登录");
            }
            throw new ApiException(ErrorCode.TOKEN_INVALID, "登录状态已失效，请重新登录");
        }
        if (Instant.now().isAfter(state.expiresAt())) {
            throw new ApiException(ErrorCode.TOKEN_INVALID, "登录已过期，请重新登录");
        }

        UserAccount account = userRepository.findById(state.userId())
                .orElseThrow(() -> new ApiException(ErrorCode.TOKEN_INVALID, "账号不存在，请重新登录"));
        if (!account.active()) {
            throw new ApiException(ErrorCode.ACCOUNT_DISABLED, "账号已被停用");
        }

        Instant refreshExpiry = Instant.now().plus(properties.jwt().refreshTtl());
        String rawNext = Tokens.newRaw();
        String nextHash = Tokens.hash(rawNext);
        refreshTokenRepository.revoke(hash, nextHash);
        refreshTokenRepository.insert(account.id(), nextHash, device, ip, refreshExpiry);

        return new Rotated(account.id(), new IssuedTokens(
                jwtService.issue(account.id(), account.username()),
                jwtService.ttlSeconds(),
                rawNext,
                properties.jwt().refreshTtl().toSeconds()));
    }

    /** 退出登录：只作废当前这一个令牌，其他设备不受影响。 */
    @Transactional
    public void revoke(String rawRefresh) {
        if (rawRefresh == null || rawRefresh.isBlank()) {
            return;
        }
        refreshTokenRepository.revoke(Tokens.hash(rawRefresh), null);
    }

    /** 改密码 / 管理员停用 / 发现重放时：全部设备下线。 */
    @Transactional
    public int revokeAll(long userId) {
        return refreshTokenRepository.revokeAll(userId);
    }

    /** 撤销指定的一台设备（只能撤自己的）。 */
    @Transactional
    public int revokeOne(long userId, long tokenId) {
        return refreshTokenRepository.revokeOne(userId, tokenId);
    }

    public List<RefreshTokenRepository.RefreshTokenRow> activeSessions(long userId) {
        return refreshTokenRepository.listActive(userId);
    }
}
