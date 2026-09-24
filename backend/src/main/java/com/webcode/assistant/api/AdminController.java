package com.webcode.assistant.api;

import com.webcode.assistant.credit.CreditAccountRepository;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.security.UserAccount;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 管理端：查账号、手动调积分、对账修正。
 *
 * <p>鉴权走 {@link AuthService#requireAdmin(long)}，<b>每次都从数据库读角色</b>，
 * 不信任令牌里带的角色 —— access token 有效期 2 小时，
 * 如果角色写死在令牌里，把某人降权后他还能力大 2 小时。
 *
 * <p>这里刻意<b>不提供「分页列出全部用户」</b>：一旦有这种接口，它就变成导出全站
 * 用户数据的口子。需要谁的数据就按用户名查谁；调积分会写流水并记下操作人。
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final CreditService creditService;
    private final AuthService authService;
    private final CurrentUser currentUser;

    public AdminController(CreditService creditService, AuthService authService, CurrentUser currentUser) {
        this.creditService = creditService;
        this.authService = authService;
        this.currentUser = currentUser;
    }

    @GetMapping("/accounts/{username}")
    public ApiModels.AdminAccountView account(@PathVariable String username) {
        authService.requireAdmin(currentUser.require().userId());
        return viewOf(username);
    }

    /**
     * 手动调整积分。
     *
     * <p>金额可正可负；负数超过余额会被拒（不允许把余额调成负数）。
     * 理由会原样写进流水，「为什么给这个人加了 500 分」永远查得到。
     */
    @PostMapping("/credits/adjust")
    public ApiModels.AdminAccountView adjust(@Valid @RequestBody ApiModels.AdjustCreditRequest request) {
        long operatorId = authService.requireAdmin(currentUser.require().userId()).id();
        creditService.adjust(request.userId(), request.amount(), request.reason(), operatorId);
        return viewOf(authService.require(request.userId()).username());
    }

    /**
     * 对账修正：把账户余额对齐成账本累计值。
     *
     * <p>只在确认账本可信时使用 —— 它假定「账本是对的、快照漂了」。
     * 反过来的情况（账本本身错了）用它会固化错误，所以不给自动流程调用。
     */
    @PostMapping("/accounts/{username}/reconcile")
    public ApiModels.AdminAccountView reconcile(@PathVariable String username) {
        authService.requireAdmin(currentUser.require().userId());
        creditService.reconcileAndFix(authService.requireByName(username).id());
        return viewOf(username);
    }

    private ApiModels.AdminAccountView viewOf(String username) {
        UserAccount user = authService.requireByName(username);
        CreditAccountRepository.CreditAccount account = creditService.accountOf(username);
        long ledgerSum = creditService.reconcile(account.userId()).ledgerSum();
        return new ApiModels.AdminAccountView(user.id(), user.username(), user.email(), user.role(),
                user.status(), account.balance(), account.totalGranted(), account.totalConsumed(),
                ledgerSum, account.balance() == ledgerSum);
    }
}
