package com.webcode.assistant.credit;

import com.webcode.assistant.config.AppProperties;
import org.springframework.stereotype.Service;

/**
 * 计费规则。整个系统里「一分钱值多少 token」只在这里定义一处。
 *
 * <p>为什么输入和输出要分开定价：一轮对话里输入往往是输出的几十倍
 * （整个文件 + 历史 + 工具结果都算输入），如果按同一个单价算，
 * 模型每多说一句话的边际成本会被输入摊薄到看不见，
 * 于是「把整个仓库贴进 prompt」几乎不要钱 —— 那正是最烧钱、也最没必要的用法。
 * 输出贵一些，能把这个激励掰回来。
 *
 * <p>为什么向上取整而不是四舍五入：计费宁可多算千分之一，也不能出现
 * 「用了 999 token 记 0 分」这种账 —— 一旦有 0 分记录，账本对账逻辑会变得难以解释。
 */
@Service
public class PricingService {

    private final AppProperties properties;

    public PricingService(AppProperties properties) {
        this.properties = properties;
    }

    /** 本轮实际消耗的积分。 */
    public long costFor(long inputTokens, long outputTokens) {
        AppProperties.Credit credit = properties.credit();
        long input = perThousand(Math.max(0, inputTokens), credit.creditsPer1kInput());
        long output = perThousand(Math.max(0, outputTokens), credit.creditsPer1kOutput());
        return Math.max(input + output, Math.max(1, credit.minChargePerTurn()));
    }

    /** 每轮预扣多少。取「配置的预扣值」与「当前余额」的较小值：
     * 余额只剩 5 分时预扣 30 会直接扣不动，从而把「其实还够说几句话」的用户挡在门外。
     */
    public long estimateHold(long balance) {
        long configured = holdCredits();
        if (balance <= 0) {
            return 0;
        }
        return Math.min(configured, balance);
    }

    /** 配置的每轮预扣额度（未与余额比较），用于在界面上解释「为什么先扣这么多」。 */
    public long holdCredits() {
        return Math.max(1, properties.credit().holdCredits());
    }

    /** 账号至少要有多少分才允许发起一轮对话。 */
    public long minChargePerTurn() {
        return Math.max(1, properties.credit().minChargePerTurn());
    }

    public long lowBalanceThreshold() {
        return properties.credit().lowBalanceThreshold();
    }

    public long signupBonus() {
        return properties.credit().signupBonus();
    }

    public boolean enforceBalance() {
        return properties.credit().enforceBalance();
    }

    public long per1kInput() {
        return properties.credit().creditsPer1kInput();
    }

    public long per1kOutput() {
        return properties.credit().creditsPer1kOutput();
    }

    /** 人话版计费说明，前端直接展示，避免把单价散落在前端各页面里。 */
    public String explain() {
        return "每 1000 输入 token 消耗 " + per1kInput() + " 分，"
                + "每 1000 输出 token 消耗 " + per1kOutput() + " 分；"
                + "单轮最低 " + minChargePerTurn() + " 分。";
    }

    private long perThousand(long tokens, long creditsPer1k) {
        if (tokens <= 0 || creditsPer1k <= 0) {
            return 0;
        }
        return (tokens * creditsPer1k + 999) / 1000;
    }
}
