package com.webcode.assistant.llm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 用量守卫：每用户 QPS 限流 + 每日 token 配额。
 *
 * <p>Redis 优先，但<b>必须能在没有 Redis 时降级</b>。做法：
 * <ul>
 *   <li>计数走 Redis（{@code INCR} + 过期），多实例部署时限流才是全局准确的；</li>
 *   <li>Redis 任何一次操作失败，就打开 30 秒的熔断窗口，期间直接用进程内计数器
 *       —— 避免每个请求都要等一次连接超时；</li>
 *   <li>进程内是固定窗口计数，只在单实例下准确，这是可接受的降级（限流不是安全边界，
 *       真正的边界是路径校验与配额）。</li>
 * </ul>
 */
@Component
public class UsageGuard {

    private static final Logger log = LoggerFactory.getLogger(UsageGuard.class);
    private static final DateTimeFormatter DAY_FORMAT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final Duration REDIS_CIRCUIT_COOLDOWN = Duration.ofSeconds(30);
    private static final long TOKEN_KEY_TTL_HOURS = 26;

    /** 健康探测用的哑 key：只读不写，永远不会产生数据。 */
    private static final String PROBE_KEY = "wca:health:probe";

    private final StringRedisTemplate redis;
    private final LlmProperties properties;

    /** 进程内降级计数：key -> 计数。 */
    private final Map<String, AtomicLong> localCounters = new ConcurrentHashMap<>();

    /** Redis 熔断标记：> 当前时间戳表示处于熔断中。 */
    private volatile long redisCircuitOpenUntil = 0L;

    public UsageGuard(StringRedisTemplate redis, LlmProperties properties) {
        this.redis = redis;
        this.properties = properties;
    }

    /**
     * 请求前检查：超出每用户每秒上限就抛 429。
     */
    public void checkRequestAllowed(long userId) {
        int limit = properties.requestsPerSecond();
        if (limit <= 0) {
            return;
        }
        long epochSecond = System.currentTimeMillis() / 1000;
        String key = "wca:rl:" + userId + ":" + epochSecond;
        long count = increment(key, Duration.ofSeconds(2));
        if (count > limit) {
            throw new ApiException(ErrorCode.RATE_LIMITED,
                    "每秒最多 " + limit + " 次对话请求，请稍候再发");
        }
    }

    /**
     * 记录本轮消耗的 token。超配额时抛异常，但<b>先记账再判断</b>，
     * 避免超限请求反复试探时账目被冻结在临界值。
     */
    public void recordTokens(long userId, long tokens) {
        if (tokens <= 0) {
            return;
        }
        long total = increment(tokenKey(userId), Duration.ofHours(TOKEN_KEY_TTL_HOURS));
        if (total > properties.dailyTokenLimit()) {
            throw new ApiException(ErrorCode.QUOTA_EXCEEDED,
                    "今日 token 用量已达上限（" + properties.dailyTokenLimit() + "）");
        }
    }

    /** 今日已用 token，供前端展示。 */
    public long todayTokens(long userId) {
        String key = tokenKey(userId);
        String value = redisGet(key);
        if (value == null) {
            AtomicLong local = localCounters.get(key);
            return local == null ? 0 : local.get();
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    public long dailyLimit() {
        return properties.dailyTokenLimit();
    }

    // ---------------------------------------------------------------- 内部

    private String tokenKey(long userId) {
        return "wca:tok:" + userId + ":" + LocalDate.now().format(DAY_FORMAT);
    }

    private long increment(String key, Duration ttl) {
        if (!isRedisCircuitOpen()) {
            try {
                Long value = redis.opsForValue().increment(key);
                if (value != null) {
                    if (value == 1L) {
                        redis.expire(key, ttl);
                    }
                    return value;
                }
            } catch (RuntimeException ex) {
                openRedisCircuit(ex);
            }
        }
        return localCounters.computeIfAbsent(key, ignored -> new AtomicLong()).incrementAndGet();
    }

    private String redisGet(String key) {
        if (isRedisCircuitOpen()) {
            return null;
        }
        try {
            return redis.opsForValue().get(key);
        } catch (RuntimeException ex) {
            openRedisCircuit(ex);
            return null;
        }
    }

    private boolean isRedisCircuitOpen() {
        return System.currentTimeMillis() < redisCircuitOpenUntil;
    }

    private void openRedisCircuit(RuntimeException ex) {
        if (!isRedisCircuitOpen()) {
            log.warn("Redis 不可用，限流与用量计数降级为进程内实现（{} 秒后重试）: {}",
                    REDIS_CIRCUIT_COOLDOWN.toSeconds(), ex.getMessage());
        }
        redisCircuitOpenUntil = System.currentTimeMillis() + REDIS_CIRCUIT_COOLDOWN.toMillis();
    }

    /** 仅供健康检查与测试观察当前处于哪种模式。 */
    public boolean usingRedis() {
        return !isRedisCircuitOpen();
    }

    /**
     * 主动探测 Redis，并返回是否真的能用。
     *
     * <p>为什么不能直接用 {@link #usingRedis()} 报健康状态：熔断标记是「惰性」的 ——
     * 进程刚起、一个对话请求都还没发过时，它一定是「未熔断」，
     * 于是健康检查会在 Redis 根本没起来的情况下报「可用」。健康检查必须说真话，
     * 所以这里真的打一次极轻量的 GET（miss 的 key，不产生任何数据）。
     *
     * <p>探测总是真实发起，不受熔断窗口影响：熔断的意义是「别让每个业务请求都等超时」，
     * 而 /health 不是热路径（默认 15 秒一次），必须能发现 Redis 恢复。
     */
    public boolean probeRedis() {
        try {
            redis.opsForValue().get(PROBE_KEY);
            if (isRedisCircuitOpen()) {
                log.info("Redis 已恢复，限流与用量计数回到 Redis 实现");
            }
            redisCircuitOpenUntil = 0L;
            return true;
        } catch (RuntimeException ex) {
            openRedisCircuit(ex);
            return false;
        }
    }
}
