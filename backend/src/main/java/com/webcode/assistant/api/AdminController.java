package com.webcode.assistant.api;

import com.webcode.assistant.admin.AdminRepository;
import com.webcode.assistant.admin.AdminService;
import com.webcode.assistant.credit.CreditLedgerRepository;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.security.AppUserPrincipal;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.security.RequestContext;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;

/**
 * 管理端：用户管理、账号处置、积分与订单、审计与统计。
 *
 * <p>鉴权走 {@link AuthService#requireAdmin(long)}，<b>每次都从数据库读角色</b>，
 * 不信任令牌里带的角色 —— access token 有效期 2 小时，
 * 如果角色写死在令牌里，把某人降权后他还能力大 2 小时。
 *
 * <p>三条设计原则，每一条都是为了「出问题时能查、不出问题时不能滥权」：
 * <ul>
 *   <li><b>所有写操作都写审计</b>（谁、什么时候、对谁、做了什么、为什么）；</li>
 *   <li><b>处置对象一律用 id 而不是用户名</b> —— 用户名可改，按名字处置等于留了个改名就躲开的口子；</li>
 *   <li><b>自己不能处置自己</b>，也不能把最后一个可用管理员降权或停用（守卫在 AdminService 里）。</li>
 * </ul>
 *
 * <p>分页接口都设了上限（{@code AdminService.MAX_PAGE_SIZE}）：没有上限的分页就是一个拖库工具。
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminService adminService;
    private final CreditService creditService;
    private final AuthService authService;
    private final CurrentUser currentUser;
    private final RequestContext requestContext;

    public AdminController(AdminService adminService,
                           CreditService creditService,
                           AuthService authService,
                           CurrentUser currentUser,
                           RequestContext requestContext) {
        this.adminService = adminService;
        this.creditService = creditService;
        this.authService = authService;
        this.currentUser = currentUser;
        this.requestContext = requestContext;
    }

    // ------------------------------------------------------------ 统计看板

    @GetMapping("/stats")
    public ApiModels.AdminStatsView stats() {
        requireAdmin();
        AdminRepository.Stats stats = adminService.stats();
        return new ApiModels.AdminStatsView(stats.totalUsers(), stats.newUsersToday(), stats.activeToday(),
                stats.admins(), stats.disabledUsers(), stats.lockedUsers(), stats.unverifiedEmail(),
                stats.pendingOrders(), stats.paidOrders(), stats.totalCreditsGranted(),
                stats.totalCreditsConsumed(), stats.creditsToday(), stats.turnsToday());
    }

    @GetMapping("/trend")
    public List<ApiModels.AdminTrendPoint> trend(@RequestParam(defaultValue = "14") int days) {
        requireAdmin();
        return adminService.trend(days).stream()
                .map(point -> new ApiModels.AdminTrendPoint(point.day(), point.signups(), point.credits()))
                .toList();
    }

    // ------------------------------------------------------------ 用户列表与详情

    @GetMapping("/users")
    public ApiModels.AdminUserPage users(@RequestParam(required = false) String keyword,
                                         @RequestParam(required = false) String role,
                                         @RequestParam(required = false) String status,
                                         @RequestParam(required = false) Boolean verified,
                                         @RequestParam(required = false) String sort,
                                         @RequestParam(defaultValue = "1") int page,
                                         @RequestParam(defaultValue = "20") int size) {
        requireAdmin();
        AdminService.UserPage result = adminService.users(keyword, role, status, verified, sort, page, size,
                AdminService.MAX_PAGE_SIZE);
        return new ApiModels.AdminUserPage(result.items().stream().map(AdminController::toRow).toList(),
                result.total(), result.page(), result.size());
    }

    @GetMapping("/users/{userId}")
    public ApiModels.AdminUserDetailView user(@PathVariable long userId,
                                              @RequestParam(defaultValue = "15") int ledgerLimit) {
        requireAdmin();
        AdminService.UserDetail detail = adminService.detail(userId, Math.min(Math.max(ledgerLimit, 1), 50));
        return new ApiModels.AdminUserDetailView(
                toRow(detail.user()),
                detail.ledger().stream().map(AdminController::toLedger).toList(),
                detail.sessions().stream()
                        .map(session -> new ApiModels.AdminSessionView(session.id(), session.device(),
                                session.ip(), instant(session.createdAt()), instant(session.expiresAt())))
                        .toList(),
                detail.audit().stream().map(AdminController::toAudit).toList());
    }

    // ------------------------------------------------------------ 账号处置

    @PostMapping("/users/{userId}/status")
    public ApiModels.AdminUserRowView setStatus(@PathVariable long userId,
                                                @Valid @RequestBody ApiModels.AdminStatusRequest request) {
        AppUserPrincipal operator = requireAdmin();
        return toRow(adminService.setStatus(operator.userId(), operator.username(), userId,
                request.status(), request.reason(), requestContext.ip()));
    }

    @PostMapping("/users/{userId}/unlock")
    public ApiModels.AdminUserRowView unlock(@PathVariable long userId) {
        AppUserPrincipal operator = requireAdmin();
        return toRow(adminService.unlock(operator.userId(), operator.username(), userId,
                requestContext.ip()));
    }

    @PostMapping("/users/{userId}/role")
    public ApiModels.AdminUserRowView setRole(@PathVariable long userId,
                                              @Valid @RequestBody ApiModels.AdminRoleRequest request) {
        AppUserPrincipal operator = requireAdmin();
        return toRow(adminService.setRole(operator.userId(), operator.username(), userId,
                request.role(), requestContext.ip()));
    }

    @PostMapping("/users/{userId}/reset-password")
    public ApiModels.AdminResetPasswordResponse resetPassword(@PathVariable long userId) {
        AppUserPrincipal operator = requireAdmin();
        String temporary = adminService.resetPassword(operator.userId(), operator.username(), userId,
                requestContext.ip());
        return new ApiModels.AdminResetPasswordResponse(temporary);
    }

    @PostMapping("/users/{userId}/revoke-sessions")
    public ApiModels.AdminCountResponse revokeSessions(@PathVariable long userId) {
        AppUserPrincipal operator = requireAdmin();
        int revoked = adminService.revokeSessions(operator.userId(), operator.username(), userId,
                requestContext.ip());
        return new ApiModels.AdminCountResponse(revoked);
    }

    @PostMapping("/users/{userId}/credits")
    public ApiModels.AdminBalanceResponse adjustCredits(@PathVariable long userId,
                                                        @Valid @RequestBody ApiModels.AdminCreditAdjustRequest request) {
        AppUserPrincipal operator = requireAdmin();
        long balance = adminService.adjustCredits(operator.userId(), operator.username(), userId,
                request.amount(), request.reason(), requestContext.ip());
        CreditService.Reconciliation reconciliation = creditService.reconcile(userId);
        return new ApiModels.AdminBalanceResponse(balance, reconciliation.ledgerSum(),
                reconciliation.consistent());
    }

    @PostMapping("/users/{userId}/reconcile")
    public ApiModels.AdminBalanceResponse reconcile(@PathVariable long userId) {
        AppUserPrincipal operator = requireAdmin();
        CreditService.Reconciliation result = adminService.reconcile(
                operator.userId(), operator.username(), userId, requestContext.ip());
        return new ApiModels.AdminBalanceResponse(result.balance(), result.ledgerSum(), result.consistent());
    }

    // ------------------------------------------------------------ 订单

    @GetMapping("/orders")
    public ApiModels.AdminOrderPage orders(@RequestParam(required = false) String status,
                                           @RequestParam(defaultValue = "1") int page,
                                           @RequestParam(defaultValue = "20") int size) {
        requireAdmin();
        AdminService.OrderPage result = adminService.orders(status, page, size);
        return new ApiModels.AdminOrderPage(result.items().stream().map(AdminController::toOrder).toList(),
                result.total(), result.page(), result.size());
    }

    @PostMapping("/orders/{orderNo}/cancel")
    public ApiModels.AdminCountResponse cancelOrder(@PathVariable String orderNo) {
        AppUserPrincipal operator = requireAdmin();
        adminService.cancelOrder(operator.userId(), operator.username(), orderNo, requestContext.ip());
        return new ApiModels.AdminCountResponse(1);
    }

    /** 退款已支付订单。{@code reason} 选填，会进审计与订单的退款理由栏。 */
    @PostMapping("/orders/{orderNo}/refund")
    public ApiModels.AdminCountResponse refundOrder(@PathVariable String orderNo,
                                                    @RequestBody(required = false) ApiModels.AdminRefundRequest request) {
        AppUserPrincipal operator = requireAdmin();
        adminService.refundOrder(operator.userId(), operator.username(), orderNo,
                request == null ? null : request.reason(), requestContext.ip());
        return new ApiModels.AdminCountResponse(1);
    }

    // ------------------------------------------------------------ 审计

    @GetMapping("/audit")
    public ApiModels.AdminAuditPage audit(@RequestParam(required = false) String action,
                                          @RequestParam(defaultValue = "1") int page,
                                          @RequestParam(defaultValue = "20") int size) {
        requireAdmin();
        AdminService.AuditPage result = adminService.auditLog(action, page, size);
        return new ApiModels.AdminAuditPage(result.items().stream().map(AdminController::toAudit).toList(),
                result.total(), result.page(), result.size());
    }

    // ------------------------------------------------------------ 兼容旧端点

    /** 按用户名查账号（旧端点，保留给已有自检脚本与「按用户名快速排查」场景）。 */
    @GetMapping("/accounts/{username}")
    public ApiModels.AdminAccountView account(@PathVariable String username) {
        requireAdmin();
        return viewOf(username);
    }

    /** 手动调整积分（旧端点，按 userId）。与 {@code /users/{id}/credits} 同逻辑。 */
    @PostMapping("/credits/adjust")
    public ApiModels.AdminAccountView adjust(@Valid @RequestBody ApiModels.AdjustCreditRequest request) {
        AppUserPrincipal operator = requireAdmin();
        creditService.adjust(request.userId(), request.amount(), request.reason(),
                operator.userId(), operator.username());
        return viewOf(authService.require(request.userId()).username());
    }

    /** 对账修正（旧端点，按用户名）。 */
    @PostMapping("/accounts/{username}/reconcile")
    public ApiModels.AdminAccountView reconcileByUsername(@PathVariable String username) {
        requireAdmin();
        creditService.reconcileAndFix(authService.requireByName(username).id());
        return viewOf(username);
    }

    // ------------------------------------------------------------ 内部

    private AppUserPrincipal requireAdmin() {
        AppUserPrincipal principal = currentUser.require();
        authService.requireAdmin(principal.userId());
        return principal;
    }

    private ApiModels.AdminAccountView viewOf(String username) {
        var user = authService.requireByName(username);
        var account = creditService.accountOf(username);
        long ledgerSum = creditService.reconcile(account.userId()).ledgerSum();
        return new ApiModels.AdminAccountView(user.id(), user.username(), user.email(), user.role(),
                user.status(), account.balance(), account.totalGranted(), account.totalConsumed(),
                ledgerSum, account.balance() == ledgerSum);
    }

    // ------------------------------------------------------------ 组装

    private static ApiModels.AdminUserRowView toRow(AdminRepository.AdminUserRow row) {
        return new ApiModels.AdminUserRowView(row.id(), row.username(), row.email(),
                row.emailVerified(), row.role(), row.status(), row.locked(), row.disabledReason(),
                row.balance(), row.totalGranted(), row.totalConsumed(),
                instant(row.lastLoginAt()), instant(row.createdAt()));
    }

    private static ApiModels.LedgerEntryView toLedger(CreditLedgerRepository.LedgerEntry entry) {
        return new ApiModels.LedgerEntryView(entry.id(), entry.kind(), entry.delta(), entry.balanceAfter(),
                entry.reason(), entry.refType(), entry.refId(), instant(entry.createdAt()));
    }

    private static ApiModels.AdminAuditView toAudit(AdminRepository.AuditRow row) {
        return new ApiModels.AdminAuditView(row.id(), row.operatorId(), row.operatorName(), row.action(),
                row.targetType(), row.targetId(), row.targetName(), row.detail(), row.ip(),
                instant(row.createdAt()));
    }

    private static ApiModels.AdminOrderView toOrder(AdminRepository.AdminOrderRow row) {
        return new ApiModels.AdminOrderView(row.orderNo(), row.userId(), row.username(), row.planCode(),
                row.amountCents(), row.credits(), row.status(), row.provider(),
                instant(row.createdAt()), instant(row.paidAt()), instant(row.refundedAt()), row.refundReason());
    }

    /**
     * 时间统一转成 ISO-8601 字符串（带 {@code Z}）。
     *
     * <p>前端必须交给 {@code Date} 做时区换算 —— 直接截字符串会每笔差 8 小时，
     * 这个坑在积分流水上踩过一次。
     */
    private static String instant(Instant value) {
        return value == null ? null : value.toString();
    }
}
