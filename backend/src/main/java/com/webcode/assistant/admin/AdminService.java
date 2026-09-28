package com.webcode.assistant.admin;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.security.AccountStatusGuard;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.RefreshTokenRepository;
import com.webcode.assistant.security.SessionRevoker;
import com.webcode.assistant.security.UserAccount;
import com.webcode.assistant.security.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.util.List;

/**
 * 管理端业务规则。
 *
 * <p>这个类存在的意义不是「把 Controller 的 SQL 挪个地方」，而是集中处理
 * <b>「管理员能做的事也会反过来伤到平台」</b>这一类问题。三条守卫，每条都对应一次真实事故：
 *
 * <ol>
 *   <li><b>不能对自己动手。</b>管理员把自己的角色降成 USER，或者停用自己，
 *       结果就是「唯一的运维入口被自己关掉」，只能改数据库恢复。</li>
 *   <li><b>不能动最后一个可用管理员。</b>降权 / 停用前必须确认系统里还有别的 ACTIVE ADMIN。
 *       这条守卫必须在<b>事务里</b>重新数一遍，不能信前端传来的「还有一个」。</li>
 *   <li><b>所有写操作都留审计。</b>管理员能停用账号、改角色、动别人的钱 ——
 *       这些动作没有痕迹的话，「谁把我账号停了」永远查不出来。</li>
 * </ol>
 *
 * <p>另外：<b>按 id 走的管理动作一律不接受用户名</b>。用户名可以改，
 * 让「停用 zhangsan」这种指令按名字解析，等于给了一个改名就能躲开处置的口子。
 */
@Service
public class AdminService {

    private static final Logger log = LoggerFactory.getLogger(AdminService.class);

    private static final String STATUS_ACTIVE = "ACTIVE";
    private static final String STATUS_DISABLED = "DISABLED";
    private static final String ROLE_ADMIN = "ADMIN";
    private static final String ROLE_USER = "USER";

    private static final String TARGET_USER = "USER";
    private static final String TARGET_ORDER = "ORDER";

    /** 列表分页上限。没有上限的分页接口就是一个拖库工具。 */
    public static final int MAX_PAGE_SIZE = 100;

    private static final int DETAIL_MAX_CHARS = 500;
    private static final int REASON_MAX_CHARS = 200;

    /** 临时密码字母表：去掉了 0/O/1/l/I 这些看错的字符 —— 它是要念给用户听的。 */
    private static final String TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

    private final AdminRepository repository;
    private final CreditService creditService;
    private final AuthService authService;
    private final RefreshTokenRepository refreshTokens;
    private final SessionRevoker sessionRevoker;
    private final PasswordEncoder passwordEncoder;
    private final AccountStatusGuard statusGuard;
    /** 会话世代递增用。处置动作「立刻生效」的另一半靠它（见各处置方法的注释）。 */
    private final UserRepository userRepository;
    private final SecureRandom random = new SecureRandom();

    public AdminService(AdminRepository repository,
                        CreditService creditService,
                        AuthService authService,
                        RefreshTokenRepository refreshTokens,
                        SessionRevoker sessionRevoker,
                        PasswordEncoder passwordEncoder,
                        AccountStatusGuard statusGuard,
                        UserRepository userRepository) {
        this.repository = repository;
        this.creditService = creditService;
        this.authService = authService;
        this.refreshTokens = refreshTokens;
        this.sessionRevoker = sessionRevoker;
        this.passwordEncoder = passwordEncoder;
        this.statusGuard = statusGuard;
        this.userRepository = userRepository;
    }

    // ------------------------------------------------------------ 查询

    public record UserPage(List<AdminRepository.AdminUserRow> items, long total, int page, int size) {
    }

    public UserPage users(String keyword, String role, String status, Boolean emailVerified,
                          String sort, int page, int size, int maxSize) {
        int safeSize = Math.min(Math.max(size, 1), Math.min(maxSize, MAX_PAGE_SIZE));
        int safePage = Math.max(page, 1);
        AdminRepository.UserFilter filter = new AdminRepository.UserFilter(
                keyword, normalizeRole(role), normalizeStatus(status), emailVerified);
        long total = repository.countUsers(filter);
        List<AdminRepository.AdminUserRow> items =
                repository.pageUsers(filter, sort, safeSize, (safePage - 1) * safeSize);
        return new UserPage(items, total, safePage, safeSize);
    }

    /**
     * 用户详情。
     *
     * <p>一次把「这个人是谁、有多少钱、最近干了什么、被谁动过」全部拿齐 ——
     * 客服需要在一个屏里看完，而不是点四个接口。
     */
    public record UserDetail(
            AdminRepository.AdminUserRow user,
            List<com.webcode.assistant.credit.CreditLedgerRepository.LedgerEntry> ledger,
            List<RefreshTokenRepository.RefreshTokenRow> sessions,
            List<AdminRepository.AuditRow> audit
    ) {
    }

    public UserDetail detail(long userId, int ledgerLimit) {
        AdminRepository.AdminUserRow row = repository.findUser(userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "用户不存在"));
        List<RefreshTokenRepository.RefreshTokenRow> sessions;
        List<com.webcode.assistant.credit.CreditLedgerRepository.LedgerEntry> ledger;
        try {
            sessions = refreshTokens.listActive(userId);
        } catch (RuntimeException ex) {
            log.warn("读取用户会话失败 userId={}", userId, ex);
            sessions = List.of();
        }
        try {
            ledger = creditService.ledger(userId, ledgerLimit, 0).items();
        } catch (RuntimeException ex) {
            log.warn("读取用户流水失败 userId={}", userId, ex);
            ledger = List.of();
        }
        return new UserDetail(row, ledger, sessions,
                repository.recentAuditFor(TARGET_USER, String.valueOf(userId), 20));
    }

    public AdminRepository.Stats stats() {
        return repository.stats();
    }

    public List<AdminRepository.DailyPoint> trend(int days) {
        return repository.dailyTrend(days);
    }

    // ------------------------------------------------------------ 处置

    @Transactional
    public AdminRepository.AdminUserRow setStatus(long operatorId, String operatorName, long targetId,
                                                  String status, String reason, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        String normalized = normalizeStatus(status);
        if (normalized == null) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "状态只能是 ACTIVE 或 DISABLED");
        }
        if (STATUS_DISABLED.equals(normalized)) {
            guardNotSelf(operator, target, "停用");
            guardLastAdmin(target, "停用");
            String safeReason = truncate(reason, REASON_MAX_CHARS);
            if (safeReason == null) {
                throw new ApiException(ErrorCode.VALIDATION_FAILED, "停用必须填写原因，客服要据此回答用户");
            }
            repository.disable(targetId, safeReason, operatorId);
            int revoked = sessionRevoker.revokeAll(targetId);
            // 会话世代 +1：手上有未过期 access token 的也要立刻被挡（世代对不上 → 401）。
            // 光靠吊销 refresh 只能挡「下次刷新」，挡不住正在跑的请求。
            userRepository.bumpTokenEpoch(targetId);
            // 让停用立刻生效：不失效缓存的话，对方手上那张未过期的 access token
            // 还能在 TTL 窗口里继续通行（见 AccountStatusGuard）。
            statusGuard.invalidate(targetId);
            audit(operator, "USER_DISABLE", TARGET_USER, String.valueOf(targetId), target.username(),
                    "停用账号：" + safeReason + "（同时下线 " + revoked + " 个会话）", ip);
            log.info("管理员停用账号 operator={} target={} reason={}", operatorName, target.username(), safeReason);
        } else {
            guardNotSelf(operator, target, "启用");
            repository.enable(targetId);
            statusGuard.invalidate(targetId);
            audit(operator, "USER_ENABLE", TARGET_USER, String.valueOf(targetId), target.username(),
                    "恢复账号", ip);
        }
        return requireUser(targetId);
    }

    @Transactional
    public AdminRepository.AdminUserRow unlock(long operatorId, String operatorName, long targetId, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        repository.unlock(targetId);
        audit(operator, "USER_UNLOCK", TARGET_USER, String.valueOf(targetId), target.username(),
                "解除登录锁定", ip);
        return requireUser(targetId);
    }

    @Transactional
    public AdminRepository.AdminUserRow setRole(long operatorId, String operatorName, long targetId,
                                                String role, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        String normalized = normalizeRole(role);
        if (normalized == null) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "角色只能是 ADMIN 或 USER");
        }
        if (!normalized.equals(target.role())) {
            if (!ROLE_ADMIN.equals(normalized)) {
                guardNotSelf(operator, target, "降权");
                guardLastAdmin(target, "降权");
            }
            repository.updateRole(targetId, normalized);
            // 降权必须立刻生效：access token 里不带角色（每次现读库），
            // 但旧的 refresh 会话还带着「这个人是管理员」的上下文，全部作废最干净；
            // 再把会话世代 +1，连没过期的 access token 一起作废 —— 双保险。
            if (ROLE_ADMIN.equals(target.role()) && !ROLE_ADMIN.equals(normalized)) {
                int revoked = sessionRevoker.revokeAll(targetId);
                userRepository.bumpTokenEpoch(targetId);
                statusGuard.invalidate(targetId);
                log.info("管理员降权 operator={} target={} 同时下线 {} 个会话",
                        operatorName, target.username(), revoked);
            }
            audit(operator, "ROLE_CHANGE", TARGET_USER, String.valueOf(targetId), target.username(),
                    "角色 " + target.role() + " → " + normalized, ip);
        }
        return requireUser(targetId);
    }

    /**
     * 管理员重置密码。
     *
     * <p>为什么要返回一个临时密码而不是发邮件：这是「用户邮箱也进不去了」的兜底通道，
     * 走邮件等于把一个失效的通道再走一遍。临时密码只在这一处返回一次，不落库、不打日志。
     *
     * <p>重置后<b>吊销该用户全部会话</b>：改密码却留着旧会话，
     * 等于「密码变了但别人还能用」—— 那正是重置密码想解决的问题。
     */
    @Transactional
    public String resetPassword(long operatorId, String operatorName, long targetId, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        guardNotSelf(operator, target, "重置密码");

        String temporary = randomPassword();
        repository.updatePasswordHash(targetId, passwordEncoder.encode(temporary));
        int revoked = sessionRevoker.revokeAll(targetId);
        // 密码已重置，旧 access token 必须立刻死 —— 不 bump 的话它还能通行 2 小时，
        // 「重置密码却留着旧会话」正是这个动作要解决的问题。
        userRepository.bumpTokenEpoch(targetId);
        statusGuard.invalidate(targetId);
        audit(operator, "ADMIN_RESET_PASSWORD", TARGET_USER, String.valueOf(targetId), target.username(),
                "管理员重置密码（同时下线 " + revoked + " 个会话），临时密码未记录", ip);
        log.info("管理员重置密码 operator={} target={}", operatorName, target.username());
        return temporary;
    }

    @Transactional
    public int revokeSessions(long operatorId, String operatorName, long targetId, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        guardNotSelf(operator, target, "强制下线");
        int revoked = sessionRevoker.revokeAll(targetId);
        // 「强制下线」的语义就是立刻：refresh 吊销挡刷新，世代 +1 挡没过期的 access token。
        userRepository.bumpTokenEpoch(targetId);
        statusGuard.invalidate(targetId);
        audit(operator, "REVOKE_SESSIONS", TARGET_USER, String.valueOf(targetId), target.username(),
                "强制下线 " + revoked + " 个会话", ip);
        return revoked;
    }

    @Transactional
    public long adjustCredits(long operatorId, String operatorName, long targetId, long amount,
                              String reason, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        long balance = creditService.adjust(targetId, amount, reason, operatorId, operatorName);
        audit(operator, "CREDIT_ADJUST", TARGET_USER, String.valueOf(targetId), target.username(),
                (amount > 0 ? "+" : "") + amount + " 分：" + (reason == null ? "未填写理由" : reason), ip);
        return balance;
    }

    @Transactional
    public CreditService.Reconciliation reconcile(long operatorId, String operatorName, long targetId, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        AdminRepository.AdminUserRow target = requireUser(targetId);
        CreditService.Reconciliation result = creditService.reconcileAndFix(targetId);
        audit(operator, "RECONCILE", TARGET_USER, String.valueOf(targetId), target.username(),
                "对账修正：余额对齐到账本累计值 " + result.ledgerSum(),
                ip);
        return result;
    }

    // ------------------------------------------------------------ 订单

    public record OrderPage(List<AdminRepository.AdminOrderRow> items, long total, int page, int size) {
    }

    public OrderPage orders(String status, int page, int size) {
        int safeSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        int safePage = Math.max(page, 1);
        long total = repository.countOrders(normalizeOrderStatus(status));
        return new OrderPage(
                repository.pageOrders(normalizeOrderStatus(status), safeSize, (safePage - 1) * safeSize),
                total, safePage, safeSize);
    }

    /**
     * 撤销订单。
     *
     * <p>只允许撤 PENDING。已经支付的订单不提供「撤销」—— 那笔钱已经变成积分被花掉了，
     * 真正的退款是另一个流程（原路退回 + 扣回积分 + 可能余额为负的处理），
     * 这里给一个假按钮比不给更危险。
     */
    @Transactional
    public void cancelOrder(long operatorId, String operatorName, String orderNo, String ip) {
        UserAccount operator = requireAdmin(operatorId);
        if (repository.cancelOrder(orderNo) == 0) {
            throw new ApiException(ErrorCode.ORDER_NOT_PAYABLE,
                    "订单不存在或已不是待支付状态（已支付的订单需要走退款流程，不能直接撤销）");
        }
        audit(operator, "ORDER_CANCEL", TARGET_ORDER, orderNo, null, "撤销待支付订单", ip);
    }

    // ------------------------------------------------------------ 审计

    public record AuditPage(List<AdminRepository.AuditRow> items, long total, int page, int size) {
    }

    public AuditPage auditLog(String action, int page, int size) {
        int safeSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        int safePage = Math.max(page, 1);
        return new AuditPage(
                repository.pageAudit(action, safeSize, (safePage - 1) * safeSize),
                repository.countAudit(action), safePage, safeSize);
    }

    // ------------------------------------------------------------ 守卫

    /** 每次都从数据库读角色，不信令牌里带的 —— 详见 AdminController 的注释。 */
    private UserAccount requireAdmin(long operatorId) {
        return authService.requireAdmin(operatorId);
    }

    private AdminRepository.AdminUserRow requireUser(long userId) {
        return repository.findUser(userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "用户不存在"));
    }

    private void guardNotSelf(UserAccount operator, AdminRepository.AdminUserRow target, String action) {
        if (operator.id() == target.id()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "不能对「" + action + "」自己：这会把唯一的运维入口关掉。请让另一位管理员操作");
        }
    }

    /**
     * 不能动最后一个可用管理员。
     *
     * <p>必须在事务里现数一遍，而不是信请求里的参数 —— 两个管理员同时降权对方时，
     * 「先查后改」会让两边都以为对方还在。
     */
    private void guardLastAdmin(AdminRepository.AdminUserRow target, String action) {
        if (!ROLE_ADMIN.equals(target.role()) || !STATUS_ACTIVE.equals(target.status())) {
            return;
        }
        if (repository.countActiveAdmins() <= 1) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "系统里只剩这一个可用管理员，「" + action + "」之后将无人能进入管理后台。"
                            + "请先新增一位管理员");
        }
    }

    private void audit(UserAccount operator, String action, String targetType, String targetId,
                       String targetName, String detail, String ip) {
        repository.audit(operator.id(), operator.username(), action, targetType, targetId,
                truncate(targetName, 120), truncate(detail, DETAIL_MAX_CHARS), ip);
    }

    // ------------------------------------------------------------ 规整

    private static String normalizeRole(String role) {
        if (role == null || role.isBlank()) {
            return null;
        }
        String value = role.trim().toUpperCase();
        if (value.startsWith("ROLE_")) {
            // 兼容前端可能传来的 Spring 风格写法，但库里统一存不带前缀的
            value = value.substring("ROLE_".length());
        }
        return ROLE_ADMIN.equals(value) || ROLE_USER.equals(value) ? value : null;
    }

    private static String normalizeStatus(String status) {
        if (status == null || status.isBlank()) {
            return null;
        }
        String value = status.trim().toUpperCase();
        return STATUS_ACTIVE.equals(value) || STATUS_DISABLED.equals(value) ? value : null;
    }

    private static String normalizeOrderStatus(String status) {
        if (status == null || status.isBlank()) {
            return null;
        }
        String value = status.trim().toUpperCase();
        return switch (value) {
            case "PENDING", "PAID", "CANCELLED" -> value;
            default -> null;
        };
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        return trimmed.length() <= max ? trimmed : trimmed.substring(0, max);
    }

    /** 12 位随机密码，字母表去掉了易混字符。 */
    private String randomPassword() {
        StringBuilder builder = new StringBuilder(12);
        for (int i = 0; i < 12; i++) {
            builder.append(TEMP_ALPHABET.charAt(random.nextInt(TEMP_ALPHABET.length())));
        }
        return builder.toString();
    }
}
