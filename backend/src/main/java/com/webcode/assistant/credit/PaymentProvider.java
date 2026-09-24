package com.webcode.assistant.credit;

import java.util.Map;

/**
 * 支付通道。
 *
 * <p>抽这一层的原因很实在：接入微信支付 / 支付宝需要商户号、证书、回调域名，
 * 这些在开发和自检环境里都没有。<b>没有它们不代表充值这条链路就不该被写出来、
 * 更不代表不能被测试</b> —— 订单、状态机、幂等入账、流水，这些逻辑占了充值功能的
 * 九成工作量，且与具体通道无关。
 *
 * <p>所以这里定义的是<b>通道无关的契约</b>：下单时拿到「怎么付」（支付参数），
 * 事后能「问一句付没付」（对账）。换成真实通道时，只需再写一个实现类，
 * {@link CreditService} 一行都不用改。
 */
public interface PaymentProvider {

    /** 通道名，落进订单的 {@code provider} 列。 */
    String name();

    /**
     * 发起支付，返回给前端的支付参数。
     *
     * <p>不同通道给的东西不同：扫码支付给二维码内容，网页支付给跳转 URL。
     * 统一放在一个 Map 里由前端按 {@code provider} 分支渲染。
     */
    Map<String, Object> createPayment(String orderNo, int amountCents, String subject);

    /**
     * 主动查询支付结果（对账 / 补偿用）。
     *
     * <p>与回调的区别：回调是通道推给我们，可能丢、可能重复；
     * 主动查询是我们去问，用于「用户说付了但订单还是 PENDING」这种情况。
     */
    PaymentResult query(String orderNo);

    record PaymentResult(boolean paid, String txnId, String message) {
    }
}
