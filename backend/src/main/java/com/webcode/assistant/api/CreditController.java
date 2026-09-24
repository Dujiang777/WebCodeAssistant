package com.webcode.assistant.api;

import com.webcode.assistant.credit.CreditLedgerRepository;
import com.webcode.assistant.credit.CreditOrderRepository;
import com.webcode.assistant.credit.CreditPlanRepository;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 积分：余额、流水、套餐、下单、支付确认。
 *
 * <p>所有端点都<b>只能操作当前登录用户自己的数据</b> —— userId 一律从
 * {@link CurrentUser} 取，绝不接受请求参数里传 userId。
 * 「下单」这类写接口如果再收一个 userId 参数，就等于把「帮别人下单」做成了功能。
 */
@RestController
@RequestMapping("/api/credits")
public class CreditController {

    /** 流水分页上限。没有上限的分页接口，等于给了一个拖库工具。 */
    private static final int MAX_LIMIT = 100;

    private final CreditService creditService;
    private final CurrentUser currentUser;

    public CreditController(CreditService creditService, CurrentUser currentUser) {
        this.creditService = creditService;
        this.currentUser = currentUser;
    }

    @GetMapping("/summary")
    public ApiModels.CreditSummaryResponse summary() {
        return toSummary(creditService.summary(currentUser.require().userId()));
    }

    @GetMapping("/ledger")
    public ApiModels.LedgerResponse ledger(@RequestParam(defaultValue = "20") int limit,
                                          @RequestParam(defaultValue = "0") int offset) {
        CreditLedgerRepository.LedgerPage page = creditService.ledger(currentUser.require().userId(),
                Math.min(limit, MAX_LIMIT), offset);
        return new ApiModels.LedgerResponse(
                page.items().stream().map(CreditController::toEntry).toList(), page.total());
    }

    @GetMapping("/plans")
    public List<ApiModels.CreditPlanView> plans() {
        return creditService.plans().stream().map(CreditController::toPlan).toList();
    }

    @GetMapping("/orders")
    public List<ApiModels.OrderView> orders(@RequestParam(defaultValue = "20") int limit) {
        return creditService.orders(currentUser.require().userId(), limit).stream()
                .map(CreditController::toOrder)
                .toList();
    }

    @PostMapping("/orders")
    public ApiModels.OrderResponse createOrder(@Valid @RequestBody ApiModels.CreateOrderRequest request) {
        CreditService.RechargeResult result = creditService.createOrder(
                currentUser.require().userId(), request.planCode());
        return new ApiModels.OrderResponse(toOrder(result.order()), result.payment());
    }

    /**
     * 给一张待支付订单重新取支付参数。
     *
     * <p>用户关掉收银台再回来时用：真实通道的预支付会话会过期，必须重新下单，
     * 不能拿旧凭证硬打（见 {@code CreditService.reissuePayment}）。
     */
    @PostMapping("/orders/{orderNo}/payment")
    public ApiModels.OrderResponse reissuePayment(@PathVariable String orderNo) {
        CreditService.RechargeResult result = creditService.reissuePayment(
                currentUser.require().userId(), orderNo);
        return new ApiModels.OrderResponse(toOrder(result.order()), result.payment());
    }

    /**
     * 支付确认 / 回调。
     *
     * <p>它可以被重复调用，第二次起不会有任何副作用（幂等在 {@code CreditService.payOrder} 里
     * 靠「订单状态条件更新 + 账本幂等键」两层保证）。自检脚本就靠这一点断言「回调重试不重复到账」。
     */
    @PostMapping("/orders/{orderNo}/pay")
    public ApiModels.OrderView pay(@PathVariable String orderNo,
                                  @Valid @RequestBody ApiModels.PayOrderRequest request) {
        return toOrder(creditService.payOrder(currentUser.require().userId(), orderNo, request.payToken()));
    }

    @PostMapping("/orders/{orderNo}/cancel")
    public ApiModels.OrderView cancel(@PathVariable String orderNo) {
        return toOrder(creditService.cancelOrder(currentUser.require().userId(), orderNo));
    }

    /** 自查对账：余额与账本累计值是否一致。出问题时用户自己也能看到，不用等客服。 */
    @GetMapping("/reconcile")
    public ApiModels.ReconcileResponse reconcile() {
        CreditService.Reconciliation result = creditService.reconcile(currentUser.require().userId());
        return new ApiModels.ReconcileResponse(result.balance(), result.ledgerSum(), result.consistent());
    }

    // ------------------------------------------------------------- 组装

    private static ApiModels.CreditSummaryResponse toSummary(CreditService.Summary summary) {
        return new ApiModels.CreditSummaryResponse(summary.balance(), summary.totalGranted(),
                summary.totalConsumed(), summary.lowBalance(), summary.enforceBalance(),
                summary.lowBalanceThreshold(), summary.holdCredits(), summary.signupBonus(),
                summary.pricingNote());
    }

    private static ApiModels.LedgerEntryView toEntry(CreditLedgerRepository.LedgerEntry entry) {
        return new ApiModels.LedgerEntryView(entry.id(), entry.kind(), entry.delta(), entry.balanceAfter(),
                entry.reason(), entry.refType(), entry.refId(),
                entry.createdAt() == null ? null : entry.createdAt().toString());
    }

    private static ApiModels.CreditPlanView toPlan(CreditPlanRepository.CreditPlan plan) {
        return new ApiModels.CreditPlanView(plan.code(), plan.name(), plan.priceCents(), plan.credits(),
                plan.bonusCredits(), plan.totalCredits(), plan.centsPerKiloCredit(),
                plan.tag(), plan.description());
    }

    private static ApiModels.OrderView toOrder(CreditOrderRepository.CreditOrder order) {
        return new ApiModels.OrderView(order.orderNo(), order.planCode(), order.amountCents(),
                order.credits(), order.status(), order.provider(),
                order.createdAt() == null ? null : order.createdAt().toString(),
                order.paidAt() == null ? null : order.paidAt().toString());
    }
}
