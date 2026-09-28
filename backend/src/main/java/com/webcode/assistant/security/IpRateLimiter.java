package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 匿名认证接口的 IP 级限流。
 *
 * <p>为什么按 IP 而不是按账号：注册 / 找回密码发生时根本没有账号；
 * 同一个 IP 连续建几十个号、或拿别人邮箱轰炸式触发发信，都是典型的脚本行为。
 * 登录例外地也计数 —— 它虽是按账号锁定，但「拿字典挨个试用户名」绕开了单账号锁定，
 * IP 维度是第二道闸。
 *
 * <p>计数与 {@code UsageGuard} 同一套形状：Redis 固定窗口
 * （{@code wca:ip:{action}:{ip}:{windowStart}}，窗口结束自动过期），
 * Redis 连不上降级进程内 {@link AtomicLong}（单实例准确，多实例偏松 ——
 * 限流不是安全边界，是防刷的第一道闸，这个降级可接受）。
 *
 * <p>IP 来源用 {@link RequestContext#ip()}。它可能被 X-Forwarded-For 伪造 ——
 * 但伪造一个头只能把惩罚转移到攻击者自己选的假 IP 上，配合验证码
 * （每个注册都要过一张人眼识别的图）足以把脚本刷号的成本抬到不值得。
 */
@Component
public class IpRateLimiter {

    private static final Logger log = LoggerFactory.getLogger(IpRateLimiter.class);

    public enum Action {
        REGISTER("register"), LOGIN("login"), FORGOT("forgot");

        private final String label;

        Action(String label) {
            this.label = label;
        }

        String label() {
            return label;
        }
    }

    private final StringRedisTemplate redis;
    private final Duration window;
    private final Map<Action, Integer> limits;
    private final Map<String, AtomicLong> localCounters = new ConcurrentHashMap<>();
    private volatile long redisCircuitOpenUntil;

    private static final long REDIS_CIRCUIT_COOLDOWN_MS = 60_000;

    public IpRateLimiter(StringRedisTemplate redis, AppProperties properties) {
        this.redis = redis;
        this.window = properties.auth().ipWindow();
        AppProperties.Auth auth = properties.auth();
        this.limits = Map.of(
                Action.REGISTER, auth.ipMaxRegister(),
                Action.LOGIN, auth.ipMaxLogin(),
                Action.FORGOT, auth.ipMaxForgot());
    }

    /**
     * 记一次并校验是否超限。超限抛 429（{@link ErrorCode#RATE_LIMITED}），
     * 消息带上窗口剩余秒数，前端能给出「XX 秒后再试」。
     */
    public void check(Action action, String ip) {
        if (ip == null || ip.isBlank()) {
            return; // 拿不到 IP 的场景（如测试直调）不拦，账号级防线仍然在
        }
        int limit = limits.get(action);
        String key = key(action, ip);
        long count = increment(key);
        if (count <= limit) {
            return;
        }
        long retryAfter = Math.max(1, window.toSeconds() - (System.currentTimeMillis() / 1000) % window.toSeconds());
        throw new ApiException(ErrorCode.RATE_LIMITED,
                "操作过于频繁（本窗口已 %d 次），请 %d 秒后再试".formatted(limit, retryAfter));
    }

    private String key(Action action, String ip) {
        long windowStart = System.currentTimeMillis() / window.toMillis();
        return "wca:ip:" + action.label() + ":" + ip + ":" + windowStart;
    }

    private long increment(String key) {
        if (!isRedisCircuitOpen()) {
            try {
                Long value = redis.opsForValue().increment(key);
                if (value != null) {
                    if (value == 1L) {
                        redis.expire(key, window.plus(Duration.ofSeconds(5)));
                    }
                    return value;
                }
            } catch (RuntimeException ex) {
                openRedisCircuit(ex);
            }
        }
        return localCounters.computeIfAbsent(key, ignored -> new AtomicLong()).incrementAndGet();
    }

    private boolean isRedisCircuitOpen() {
        return System.currentTimeMillis() < redisCircuitOpenUntil;
    }

    private void openRedisCircuit(RuntimeException ex) {
        if (!isRedisCircuitOpen()) {
            log.warn("Redis 不可用，IP 限流降级为进程内计数（60 秒后重试）: {}", ex.getMessage());
        }
        redisCircuitOpenUntil = System.currentTimeMillis() + REDIS_CIRCUIT_COOLDOWN_MS;
    }
}
