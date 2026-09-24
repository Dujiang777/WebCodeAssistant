package com.webcode.assistant.credit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 内置模拟支付通道（默认实现）。
 *
 * <p>它把「支付」拆成两次显式调用，刻意保留真实通道的形状：
 * <ol>
 *   <li>下单 → {@link #createPayment} 返回一份支付参数（这里是确认用的 token）；</li>
 *   <li>用户在页面上点「模拟支付成功」→ 前端拿 token 回调
 *       {@code POST /api/credits/orders/{no}/pay}，服务端把订单推到 PAID 并入账。</li>
 * </ol>
 *
 * <p>为什么不做成「点一下就自动成功」：那样就绕过了<b>回调幂等</b>这条最关键的逻辑，
 * 等接真实通道时才第一次试，而支付回调重复是这个领域最常见的线上问题。
 * 现在这个形状下，脚本可以直接对同一个订单连打两次回调，
 * 断言「第二次不会重复到账」—— 这条断言在真实通道下同样有效。
 *
 * <p>{@link #query} 永远返回未支付：模拟通道没有外部状态可查，
 * 结果只存在于我们的订单表里。真实通道必须在这里真的发起查询。
 */
@Component
@ConditionalOnMissingBean(name = "realPaymentProvider")
public class MockPaymentProvider implements PaymentProvider {

    private static final Logger log = LoggerFactory.getLogger(MockPaymentProvider.class);

    @Override
    public String name() {
        return "mock";
    }

    @Override
    public Map<String, Object> createPayment(String orderNo, int amountCents, String subject) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", name());
        payload.put("orderNo", orderNo);
        payload.put("amountCents", amountCents);
        payload.put("subject", subject);
        // 真实通道这里是二维码内容或跳转 URL；模拟通道给一个一次性确认 token，
        // 前端必须原样回传才能把订单标记为已支付，形状与真实回调一致。
        payload.put("payToken", UUID.randomUUID().toString());
        payload.put("mock", true);
        payload.put("hint", "当前是内置模拟支付通道，点击「模拟支付成功」即可完成入账。"
                + "接真实支付请配置 provider 并替换 PaymentProvider 实现。");
        log.info("模拟支付下单 orderNo={} amountCents={} subject={}", orderNo, amountCents, subject);
        return payload;
    }

    @Override
    public PaymentResult query(String orderNo) {
        return new PaymentResult(false, null, "模拟通道不维护外部支付状态，请以本地订单状态为准");
    }
}
