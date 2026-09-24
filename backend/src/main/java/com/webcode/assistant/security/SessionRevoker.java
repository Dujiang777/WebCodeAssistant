package com.webcode.assistant.security;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 紧急吊销：把某个用户的全部会话一次性作废，且<b>必须活下来</b>。
 *
 * <p>为什么单独一个 Bean、单独一个事务（{@code REQUIRES_NEW}）：
 * 它的调用点 {@link TokenService#rotate} 是 {@code @Transactional} 的，而「检测到刷新令牌重放」
 * 这条路径必然要<b>抛异常告诉客户端重新登录</b> —— 异常会把同一个事务里的
 * 吊销操作一起回滚掉。也就是说：<b>重放检测看起来生效了（客户端确实被踢），
 * 但攻击者手上那个被复制的令牌依然有效</b>，因为吊销没落库。
 *
 * <p>这是「审计 / 安全副作用」这类写操作的通用形状：它们的语义是
 * 「无论外层事务成败，这件事都必须被记住」，因此必须挂在独立事务上。
 * 反例是「改密码 + 吊销旧会话」—— 那两件事必须同生共死，走同一个事务才对。
 */
@Service
public class SessionRevoker {

    private final RefreshTokenRepository refreshTokenRepository;

    public SessionRevoker(RefreshTokenRepository refreshTokenRepository) {
        this.refreshTokenRepository = refreshTokenRepository;
    }

    /** @return 被吊销的会话数 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int revokeAll(long userId) {
        return refreshTokenRepository.revokeAll(userId);
    }
}
