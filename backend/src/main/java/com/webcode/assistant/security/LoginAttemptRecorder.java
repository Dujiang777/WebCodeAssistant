package com.webcode.assistant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;

/**
 * 登录失败计数与登录审计的独立事务写入器。
 *
 * <p>为什么必须是独立事务（{@code REQUIRES_NEW}）而不是直接调仓储：
 * {@link AuthService#login} 是 {@code @Transactional} 的，而登录失败时它会
 * <b>抛 ApiException 让整个事务回滚</b>。失败计数与审计恰恰是在这条回滚路径上写的 ——
 * 写在同一个事务里就等于「扣了又退回」，计数器永远停在 0，
 * <b>锁定策略彻底失效但表面上毫无异常</b>（自检脚本第 3 组就是被这个坑住的）。
 *
 * <p>这也是「审计日志」这类数据的通用原则：它不是业务状态的一部分，
 * 它记录的是「发生过什么」，因此必须比业务事务活得更久。
 * 写入失败也不能影响登录本身，所以整段吞异常只记日志。
 */
@Service
public class LoginAttemptRecorder {

    private static final Logger log = LoggerFactory.getLogger(LoginAttemptRecorder.class);

    private final UserRepository userRepository;
    private final LoginAuditRepository loginAuditRepository;

    public LoginAttemptRecorder(UserRepository userRepository, LoginAuditRepository loginAuditRepository) {
        this.userRepository = userRepository;
        this.loginAuditRepository = loginAuditRepository;
    }

    /**
     * 记一次密码错误：失败计数 +1（到阈值则顺带写锁定时间），并落一条审计。
     *
     * <p>计数用一条 SQL 自增而不是「读出来 +1 再写回」：并发撞库时读改写会丢计数，
     * 而丢计数就等于把锁定阈值放宽了。
     *
     * @return 累加之后的失败次数（调用方据此决定是提示「还剩几次」还是直接锁定）
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int recordBadPassword(long userId, String username, int maxAttempts, Duration lockDuration,
                                String ip, String userAgent) {
        userRepository.registerFailedAttempt(userId, maxAttempts, Instant.now().plus(lockDuration));
        int attempts = userRepository.findById(userId)
                .map(UserAccount::failedAttempts)
                .orElse(maxAttempts);
        writeAudit(userId, username, LoginAuditRepository.REASON_BAD_PASSWORD, ip, userAgent);
        return attempts;
    }

    /**
     * 记一次「异常登录」（用户不存在 / 已停用 / 锁定期内尝试）。
     *
     * <p>{@code username} 允许为空——「用户不存在」这条恰恰是最需要留痕的撞库线索，
     * 但它没有任何 userId 可挂。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordAnomaly(Long userId, String username, String reason, String ip, String userAgent) {
        writeAudit(userId, username, reason, ip, userAgent);
    }

    /** 私有：审计写入失败不能连坐登录流程本身。 */
    private void writeAudit(Long userId, String username, String reason, String ip, String userAgent) {
        try {
            loginAuditRepository.record(userId, username, false, reason, ip, userAgent);
        } catch (RuntimeException ex) {
            log.warn("写登录审计失败 username={} reason={}: {}", username, reason, ex.getMessage());
        }
    }
}
