package com.webcode.assistant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 「这个账号是不是已被停用 / 手上的令牌是不是已经作废」的快速判定，供鉴权过滤器每个请求调用。
 *
 * <p><b>为什么必须有它：</b>access token 是无状态的、有效期 2 小时。停用 / 强制下线这类
 * 处置动作落到无状态令牌上，就变成「管理员点了按钮，对方还能继续用两小时」。
 * 这在「企业级用户管理」里是不能接受的：停用这个动作的全部意义就是<b>立刻</b>生效。
 *
 * <p>两个维度，一条 SQL，一份缓存：
 * <ul>
 *   <li><b>停用状态</b>：{@code users.status}。停用即拒绝，返回 403 ——
 *       账号被处理了，但令牌本身没有错，前端不该去刷新令牌；</li>
 *   <li><b>会话世代（epoch）</b>：{@code users.token_epoch}。签发时写进令牌，
 *       与库里的当前值比对，对不上返回 401 —— 令牌已经被「改密 / 强制下线 / 重置密码」作废，
 *       前端应当走刷新或重新登录。</li>
 * </ul>
 *
 * <p>两者都在 users 同一行上，{@link UserRepository#findStatusAndEpoch} 一条 SQL 拿齐，
 * 缓存也合成一份 —— 不比原来多任何查询。
 *
 * <p>为什么不干脆把状态写进令牌：那会让停用同样延迟 2 小时生效，只是把问题换个地方。
 * 真正的解法只能是每次请求现查状态，或者维护一份可失效的状态缓存 —— 这里是后者。
 *
 * <p>缓存策略：15 秒 TTL 的进程内缓存。收益是「同一用户的高频请求最多 15 秒查一次库」，
 * 代价是「处置后最多延迟 15 秒生效」。管理端在处置时显式调 {@link #invalidate(long)}，
 * 所以实际延迟通常接近 0，15 秒只是兜底（比如另一个实例做了处置）。
 *
 * <p>缓存里只存 userId → (停用, 世代)，不存用户名邮箱之类的个人信息；
 * 它是纯功能缓存，不是用户数据副本。
 */
@Component
public class AccountStatusGuard {

    private static final Logger log = LoggerFactory.getLogger(AccountStatusGuard.class);

    /** 状态缓存有效期。太短等于每请求一次查询，太长等于处置生效慢。 */
    private static final Duration TTL = Duration.ofSeconds(15);

    /**
     * 快检结果。{@code epoch} 用 Long 而不是 long：{@code null} 表示
     * 「DB 抖动没查到」，调用方按放行处理（可用性优先，见 {@link #state}）。
     */
    public record State(boolean disabled, Long epoch) {
    }

    private record Entry(State state, long expiresAtMillis) {
    }

    private final UserRepository userRepository;
    private final Map<Long, Entry> cache = new ConcurrentHashMap<>();

    public AccountStatusGuard(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /**
     * 快检当前状态。
     *
     * <p>返回值的语义必须分清三种情况：
     * <ul>
     *   <li>{@code disabled=true}：账号已被停用（或<b>不存在</b>——令牌里的 userId
     *       对应的账号没了，那张令牌当然不能再通行，这是唯一安全的默认值）；</li>
     *   <li>{@code epoch} 与令牌里的不一致：令牌已被处置动作作废；</li>
     *   <li><b>返回 {@code State(false, null)}</b>：数据库抖动查不到。按「放行」处理：
     *       可用性优先，真正的鉴权（角色、资源归属）依然在各自的业务层把关，
     *       这里只是快检。缓存这次结果毫无意义，所以不写缓存直接返回。</li>
     * </ul>
     */
    public State state(long userId) {
        long now = System.currentTimeMillis();
        Entry cached = cache.get(userId);
        if (cached != null && cached.expiresAtMillis() > now) {
            return cached.state();
        }
        UserRepository.StatusAndEpoch fresh;
        try {
            fresh = userRepository.findStatusAndEpoch(userId).orElse(null);
        } catch (RuntimeException ex) {
            log.warn("查询账号状态失败，本次放行 userId={}", userId, ex);
            return new State(false, null);
        }
        if (fresh == null) {
            // 账号不存在 = 已被删除：停用 + 世代拉满，任何令牌都过不去
            return new State(true, Long.MAX_VALUE);
        }
        State state = new State(fresh.disabled(), fresh.epoch());
        cache.put(userId, new Entry(state, now + TTL.toMillis()));
        return state;
    }

    /** 处置后立刻失效缓存，让停用 / 世代递增即时生效（不用等 TTL）。 */
    public void invalidate(long userId) {
        cache.remove(userId);
    }
}
