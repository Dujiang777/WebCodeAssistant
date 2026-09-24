package com.webcode.assistant.credit;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * AI 用量积分：账户、流水、套餐、订单。
 *
 * <p>三条贯穿全类的规则，每一处实现都在遵守它们：
 * <ol>
 *   <li><b>余额只由 {@link CreditAccountRepository} 的原子 SQL 改</b>，任何地方都不做读改写；</li>
 *   <li><b>每一笔余额变动都必须配一条流水</b>，否则对账时 {@code sum(delta)} 对不上余额；
 *       变动与记账在同一个事务里（方法上的 {@code @Transactional}），
 *       幂等键唯一索引因此变成了真正的事务级闸门，而不只是一条警告。</li>
 *   <li><b>预扣 - 结算 - 退款</b>三段式：预算不住的钱先扣着，按实际用量多退少补，
 *       跑失败就全额退回。没有预扣，余额 1 分的账号也能发起一轮消耗 5 万 token 的对话。</li>
 * </ol>
 */
@Service
public class CreditService {

    private static final Logger log = LoggerFactory.getLogger(CreditService.class);

    private final CreditAccountRepository accounts;
    private final CreditLedgerRepository ledger;
    private final CreditPlanRepository plans;
    private final CreditOrderRepository orders;
    private final PricingService pricing;
    private final PaymentProvider paymentProvider;

    public CreditService(CreditAccountRepository accounts,
                         CreditLedgerRepository ledger,
                         CreditPlanRepository plans,
                         CreditOrderRepository orders,
                         PricingService pricing,
                         PaymentProvider paymentProvider) {
        this.accounts = accounts;
        this.ledger = ledger;
        this.plans = plans;
        this.orders = orders;
        this.pricing = pricing;
        this.paymentProvider = paymentProvider;
    }

    // ------------------------------------------------------------ 视图

    public record Summary(long balance, long totalGranted, long totalConsumed,
                          boolean lowBalance, boolean enforceBalance, long lowBalanceThreshold,
                          long holdCredits, long signupBonus, String pricingNote) {
    }

    public record RechargeResult(CreditOrderRepository.CreditOrder order, Map<String, Object> payment) {
    }

    public record Reconciliation(long balance, long ledgerSum, boolean consistent) {
    }

    // ------------------------------------------------------------ 账户

    @Transactional
    public void ensureAccount(long userId) {
        accounts.ensureAccount(userId);
    }

    /**
     * 注册赠送。幂等键 {@code signup:{userId}} —— 即使注册流程被重放，也只送一次。
     *
     * @return 实际赠送的积分数；0 表示已经送过或配置为不送
     */
    @Transactional
    public long grantSignupBonus(long userId) {
        long amount = pricing.signupBonus();
        if (amount <= 0) {
            return 0;
        }
        String key = "signup:" + userId;
        if (ledger.existsByIdempotencyKey(key)) {
            return 0;
        }
        accounts.ensureAccount(userId);
        accounts.grant(userId, amount);
        ledger.insert(userId, CreditLedgerRepository.KIND_SIGNUP_BONUS, amount, accounts.balance(userId),
                "新用户注册赠送", "ADMIN", null, key);
        return amount;
    }

    public Summary summary(long userId) {
        return accounts.find(userId)
                .map(account -> new Summary(
                        account.balance(),
                        account.totalGranted(),
                        account.totalConsumed(),
                        account.balance() < pricing.lowBalanceThreshold(),
                        pricing.enforceBalance(),
                        pricing.lowBalanceThreshold(),
                        pricing.holdCredits(),
                        pricing.signupBonus(),
                        pricing.explain()))
                .orElseGet(() -> new Summary(0, 0, 0, true, pricing.enforceBalance(),
                        pricing.lowBalanceThreshold(), pricing.holdCredits(),
                        pricing.signupBonus(), pricing.explain()));
    }

    /** 对话前的余额闸门。不足时抛 402，前端据此直接引导充值。 */
    public void requireAffordable(long userId) {
        if (!pricing.enforceBalance()) {
            return;
        }
        long balance = accounts.balance(userId);
        long min = pricing.minChargePerTurn();
        if (balance < min) {
            throw new ApiException(ErrorCode.INSUFFICIENT_CREDITS,
                    "积分不足（当前 " + balance + " 分，单轮最低需要 " + min + " 分），充值后即可继续");
        }
    }

    /**
     * 预扣。返回实际预扣的积分数（可能为 0：余额刚好只够最低消费时不再预扣）。
     *
     * @param refId 本轮的唯一标识（用落库后的用户消息 id），结算与退款都靠它对齐
     */
    @Transactional
    public long hold(long userId, String refId) {
        if (!pricing.enforceBalance()) {
            return 0;
        }
        requireAffordable(userId);
        accounts.ensureAccount(userId);

        long balance = accounts.balance(userId);
        long amount = pricing.estimateHold(balance);
        if (amount <= 0) {
            return 0;
        }
        String key = idempotencyKey(CreditLedgerRepository.KIND_HOLD, userId, refId);
        if (ledger.existsByIdempotencyKey(key)) {
            return 0;
        }
        if (!accounts.debit(userId, amount)) {
            // 并发下余额被另一轮抢走了：这里必须失败，不能扣成负数
            throw new ApiException(ErrorCode.INSUFFICIENT_CREDITS,
                    "积分不足（当前 " + accounts.balance(userId) + " 分），充值后即可继续");
        }
        ledger.insert(userId, CreditLedgerRepository.KIND_HOLD, -amount, accounts.balance(userId),
                "本轮对话预扣", "CHAT", refId, key);
        return amount;
    }

    /**
     * 按真实用量结算，多退少补。
     *
     * @return 本轮最终计入的积分数
     */
    @Transactional
    public long settle(long userId, String refId, long held, long inputTokens, long outputTokens) {
        long actual = pricing.costFor(inputTokens, outputTokens);
        String key = idempotencyKey(CreditLedgerRepository.KIND_SETTLE, userId, refId);
        if (ledger.existsByIdempotencyKey(key)) {
            return actual;
        }

        // 能收到多少：真实消耗与实际余额取小。收不满时不追债 —— 欠款追讨是另一个系统的事，
        // 这里只保证「余额不会变负、账本与余额始终一致」，并把差额记进日志供人工核对。
        long balance = accounts.balance(userId);
        long chargeable = Math.min(actual, held + Math.max(0, balance));
        long balanceDelta = held - chargeable;
        if (!accounts.applySettle(userId, balanceDelta, chargeable)) {
            // 极罕见的并发：重新读一次余额再试一次
            long retryBalance = Math.max(0, accounts.balance(userId));
            chargeable = Math.min(actual, held + retryBalance);
            balanceDelta = held - chargeable;
            accounts.applySettle(userId, balanceDelta, chargeable);
        }
        if (chargeable < actual) {
            log.warn("用量超出可收额度 userId={} actual={} charged={} refId={}", userId, actual, chargeable, refId);
        }

        ledger.insert(userId, CreditLedgerRepository.KIND_SETTLE, balanceDelta, accounts.balance(userId),
                "本轮对话结算（输入 " + inputTokens + " / 输出 " + outputTokens + " token）",
                "CHAT", refId, key);
        return chargeable;
    }

    /** 全额退回预扣（回合失败、模型未配置、被限额拦下等）。 */
    @Transactional
    public void release(long userId, String refId, long amount, String reason) {
        if (amount <= 0) {
            return;
        }
        String key = idempotencyKey(CreditLedgerRepository.KIND_RELEASE, userId, refId);
        if (ledger.existsByIdempotencyKey(key)) {
            return;
        }
        accounts.refund(userId, amount);
        ledger.insert(userId, CreditLedgerRepository.KIND_RELEASE, amount, accounts.balance(userId),
                reason, "CHAT", refId, key);
    }

    // ------------------------------------------------------------ 管理端

    /**
     * 管理员手动调整。
     *
     * <p>刻意<b>不设幂等键</b>：人工调整天然可能重复（补两次），
     * 用幂等键会让人以为「再点一次没生效」。重复就重复，流水里两次都看得见，
     * 这也是审计该有的样子。
     */
    @Transactional
    public long adjust(long userId, long amount, String reason, long operatorId) {
        if (amount == 0) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "调整额度不能为 0");
        }
        accounts.ensureAccount(userId);
        if (amount > 0) {
            accounts.grant(userId, amount);
        } else if (!accounts.debit(userId, -amount)) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "扣减额度超过当前余额（" + accounts.balance(userId) + " 分）");
        }
        ledger.insert(userId, CreditLedgerRepository.KIND_ADJUST, amount, accounts.balance(userId),
                (reason == null || reason.isBlank() ? "管理员调整" : reason) + "｜操作人 #" + operatorId,
                "ADMIN", String.valueOf(operatorId), null);
        return accounts.balance(userId);
    }

    public CreditLedgerRepository.LedgerPage ledger(long userId, int limit, int offset) {
        return ledger.page(userId, Math.min(Math.max(limit, 1), 100), Math.max(offset, 0));
    }

    public Reconciliation reconcile(long userId) {
        long balance = accounts.balance(userId);
        long sum = ledger.sumDelta(userId);
        return new Reconciliation(balance, sum, balance == sum);
    }

    /** 对账并对齐（只在确认账本可信时使用）。 */
    @Transactional
    public Reconciliation reconcileAndFix(long userId) {
        accounts.ensureAccount(userId);
        accounts.resetBalanceFromLedger(userId);
        return reconcile(userId);
    }

    // ------------------------------------------------------------ 套餐与订单

    public List<CreditPlanRepository.CreditPlan> plans() {
        return plans.listActive();
    }

    /**
     * 为一张<b>已存在</b>的待支付订单重新取一份支付参数。
     *
     * <p>为什么必须有这个端点，而不是让前端把上次的 payToken 存起来复用：
     * 真实支付通道的预支付会话是<b>会过期</b>的（微信 prepay_id 两小时、支付宝 trade_no 同样有窗口）。
     * 用户关掉收银台过一会儿再回来，旧凭证已经无效 —— 那时唯一正确的做法是
     * 回到通道那里<b>重新下单</b>，而不是拿旧凭证硬打。所以这条链路必须存在，
     * 只是模拟通道下它看起来「什么都没做」。
     *
     * <p>已支付 / 已取消的订单不给重新取参数：前者不必，后者要先重新下单。
     */
    @Transactional
    public RechargeResult reissuePayment(long userId, String orderNo) {
        CreditOrderRepository.CreditOrder order = requireOwnOrder(userId, orderNo);
        if (CreditOrderRepository.STATUS_PAID.equals(order.status())) {
            throw new ApiException(ErrorCode.ORDER_NOT_PAYABLE, "该订单已支付完成");
        }
        if (!CreditOrderRepository.STATUS_PENDING.equals(order.status())) {
            throw new ApiException(ErrorCode.ORDER_NOT_PAYABLE, "该订单已取消，请重新下单");
        }
        CreditPlanRepository.CreditPlan plan = plans.find(order.planCode()).orElse(null);
        String subject = (plan == null ? order.planCode() : plan.name())
                + " · " + order.credits() + " 积分";
        return new RechargeResult(order,
                paymentProvider.createPayment(orderNo, order.amountCents(), subject));
    }

    /** 按 id 取订单并校验归属。别人的订单一律报「不存在」，不透露单号是否真实存在。 */
    private CreditOrderRepository.CreditOrder requireOwnOrder(long userId, String orderNo) {
        CreditOrderRepository.CreditOrder order = orders.find(orderNo)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "订单不存在"));
        if (order.userId() != userId) {
            throw new ApiException(ErrorCode.NOT_FOUND, "订单不存在");
        }
        return order;
    }

    @Transactional
    public RechargeResult createOrder(long userId, String planCode) {
        CreditPlanRepository.CreditPlan plan = plans.find(planCode)
                .filter(CreditPlanRepository.CreditPlan::active)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "套餐不存在或已下架"));

        String orderNo = UUID.randomUUID().toString();
        orders.insert(orderNo, userId, plan.code(), plan.priceCents(), plan.totalCredits(),
                paymentProvider.name());
        CreditOrderRepository.CreditOrder order = orders.find(orderNo)
                .orElseThrow(() -> new ApiException(ErrorCode.INTERNAL_ERROR, "订单创建失败"));
        Map<String, Object> payment = paymentProvider.createPayment(
                orderNo, plan.priceCents(), plan.name() + " · " + plan.totalCredits() + " 积分");
        return new RechargeResult(order, payment);
    }

    /**
     * 支付回调 / 主动确认。
     *
     * <p>幂等的实现分两层，缺一不可：
     * <ol>
     *   <li>{@code markPaid} 用 {@code where status='PENDING'} 做条件更新，
     *       只有第一次能成功 —— 这是「不会重复入账」的真正闸门；</li>
     *   <li>账本再挂一个 {@code recharge:{orderNo}} 幂等键，
     *       即使将来有人在别处也给订单入账，也不会重复加积分。</li>
     * </ol>
     * 支付回调重试是常态，这段代码必须能承受住「同一订单打十次」。
     */
    @Transactional
    public CreditOrderRepository.CreditOrder payOrder(long userId, String orderNo, String payToken) {
        CreditOrderRepository.CreditOrder order = orders.find(orderNo)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "订单不存在"));
        // 不是自己的订单一律报「不存在」，不透露「这个单号真实存在」
        if (order.userId() != userId) {
            throw new ApiException(ErrorCode.NOT_FOUND, "订单不存在");
        }
        if (CreditOrderRepository.STATUS_PAID.equals(order.status())) {
            return order;
        }
        if (!CreditOrderRepository.STATUS_PENDING.equals(order.status())) {
            throw new ApiException(ErrorCode.ORDER_NOT_PAYABLE, "该订单已取消，请重新下单");
        }
        if (payToken == null || payToken.isBlank()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "缺少支付凭证");
        }

        // 真实通道在这一步应校验回调签名；模拟通道只要求凭证非空，保留调用形状。
        String txnId = paymentProvider.name() + "-" + UUID.randomUUID();
        if (!orders.markPaid(orderNo, txnId)) {
            // 并发或重复回调：订单已被别人推到 PAID，本次不再入账
            return orders.find(orderNo).orElse(order);
        }

        String key = "recharge:" + orderNo;
        if (!ledger.existsByIdempotencyKey(key)) {
            accounts.ensureAccount(userId);
            accounts.grant(userId, order.credits());
            ledger.insert(userId, CreditLedgerRepository.KIND_RECHARGE, order.credits(),
                    accounts.balance(userId), "充值套餐 " + order.planCode(), "ORDER", orderNo, key);
        }
        return orders.find(orderNo).orElse(order);
    }

    @Transactional
    public CreditOrderRepository.CreditOrder cancelOrder(long userId, String orderNo) {
        CreditOrderRepository.CreditOrder order = orders.find(orderNo)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "订单不存在"));
        if (order.userId() != userId) {
            throw new ApiException(ErrorCode.NOT_FOUND, "订单不存在");
        }
        orders.cancel(orderNo, userId);
        return orders.find(orderNo).orElse(order);
    }

    public List<CreditOrderRepository.CreditOrder> orders(long userId, int limit) {
        return orders.listByUser(userId, Math.min(Math.max(limit, 1), 50));
    }

    /** 管理端：按用户名查积分账户。 */
    public CreditAccountRepository.CreditAccount accountOf(String username) {
        return accounts.findByUsername(username)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "用户不存在或尚无积分账户"));
    }

    private static String idempotencyKey(String kind, long userId, String refId) {
        String key = kind + ":" + userId + ":" + refId;
        return key.length() <= 96 ? key : key.substring(0, 96);
    }
}
