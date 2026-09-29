package com.webcode.assistant.credit;

import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.llm.ResolvedModel;
import org.springframework.stereotype.Service;

/**
 * 计费规则。整个系统里「一分钱值多少 token」只在这里定义。
 *
 * <p><b>V6 起单价挂在模型上</b>，而不是全局一个配置值。这是「可选模型」这个需求的必然结果：
 * 如果 12 分/千 token 的旗舰模型和 1 分/千 token 的轻量模型按同一个单价扣，
 * 那选贵的那个反而是对用户更划算的选择 —— 整个定价体系立刻失效。
 * 全局配置只在「目录里查不到这个模型」时兜底。
 *
 * <p>为什么输入和输出要分开定价：一轮对话里输入往往是输出的几十倍
 * （整个文件 + 历史 + 工具结果都算输入），如果按同一个单价算，
 * 模型每多说一句话的边际成本会被输入摊薄到看不见，
 * 于是「把整个仓库贴进 prompt」几乎不要钱 —— 那正是最烧钱、也最没必要的用法。
 *
 * <p>为什么向上取整而不是四舍五入：计费宁可多算千分之一，也不能出现
 * 「用了 999 token 记 0 分」这种账 —— 一旦有 0 分记录，账本对账逻辑会变得难以解释。
 */
@Service
public class PricingService {

    /** 预测一轮的输入量（千 token）：整个文件 + 历史 + 工具结果。 */
    private static final long ESTIMATED_INPUT_1K = 12;

    /** 预测一轮的输出量（千 token）：改动说明 + diff。 */
    private static final long ESTIMATED_OUTPUT_1K = 2;

    private final AppProperties properties;

    public PricingService(AppProperties properties) {
        this.properties = properties;
    }

    // ------------------------------------------------------------ 按模型计价

    /**
     * 本轮实际消耗的积分。
     *
     * <p>{@code model.billable() == false}（用户自带 Key，且平台不收服务费）时直接返回 0：
     * 那笔算力钱是用户自己付给模型厂商的，平台再扣一遍等于同一个 token 收两次费。
     * 这个判断放在最外层，是为了保证「免积分」不会被下面的最低消费兜底
     * （{@code minChargePerTurn} 默认 1 分，会把免积分变成每轮扣 1 分）。
     */
    public long costFor(ResolvedModel model, long inputTokens, long outputTokens) {
        if (model != null && !model.billable()) {
            return 0;
        }
        long per1kInput = model == null ? per1kInput() : model.per1kInput();
        long per1kOutput = model == null ? per1kOutput() : model.per1kOutput();
        if (per1kInput <= 0 && per1kOutput <= 0) {
            // 单价为 0 是合法的（平台送额度 / 免费档模型），此时不能强行收最低消费 ——
            // 那会让「免费模型」不免费，直接违背定价表。
            return 0;
        }
        long input = perThousand(Math.max(0, inputTokens), per1kInput);
        long output = perThousand(Math.max(0, outputTokens), per1kOutput);
        return Math.max(input + output, minChargePerTurn());
    }

    /**
     * 每轮预扣多少。
     *
     * <p>预扣要跟着模型单价走：旗舰模型单轮可能烧掉几百积分，
     * 固定预扣 30 分等于「余额 40 分就能发起一轮实际消耗 300 分的对话」，
     * 结算时收不满只能记一笔坏账。
     *
     * <p>估算口径是「12k 输入 + 2k 输出」（与 V6 定价注释同一套假设），
     * 再用 {@code holdCeiling} 封顶，防止极端单价把单轮预扣推到四位数。
     *
     * <p>最后与余额取小：余额只剩 5 分时预扣 30 会直接扣不动，
     * 从而把「其实还够说一句话」的用户挡在门外。
     */
    public long estimateHold(long balance, ResolvedModel model) {
        if (balance <= 0) {
            return 0;
        }
        if (model != null && !model.billable()) {
            return 0;
        }
        long scaled = holdCredits();
        if (model != null) {
            scaled = Math.max(scaled,
                    model.per1kInput() * ESTIMATED_INPUT_1K + model.per1kOutput() * ESTIMATED_OUTPUT_1K);
        }
        long capped = Math.min(scaled, Math.max(1, properties.credit().holdCeiling()));
        return Math.min(capped, balance);
    }

    // ------------------------------------------------------------ 全局兜底与阈值

    /** 不带模型的兜底计价，用于目录里查不到该模型的历史数据重算。 */
    public long costFor(long inputTokens, long outputTokens) {
        return costFor(null, inputTokens, outputTokens);
    }

    /** 配置的每轮预扣额度（未与余额、模型比较），用于在界面上解释「为什么先扣这么多」。 */
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

    /** 免费额度重置周期（天）。0 = 一次性赠送。 */
    public long quotaResetDays() {
        return properties.credit().quotaResetDays();
    }

    public boolean enforceBalance() {
        return properties.credit().enforceBalance();
    }

    /** 自带 Key 的模型是否免积分。 */
    public boolean byokFree() {
        return properties.credit().byokFree();
    }

    public long per1kInput() {
        return properties.credit().creditsPer1kInput();
    }

    public long per1kOutput() {
        return properties.credit().creditsPer1kOutput();
    }

    /**
     * 人话版计费说明，前端直接展示。
     *
     * <p>有模型时说的是这个模型的价，没有时说的是兜底价 —— 让用户看着自己选的东西算账，
     * 而不是看一段与实际扣费无关的通用文案。
     */
    public String explain(ResolvedModel model) {
        if (model != null && !model.billable()) {
            return "「" + model.displayName() + "」用的是你自己的 API Key，本轮不消耗平台积分。";
        }
        long in = model == null ? per1kInput() : model.per1kInput();
        long out = model == null ? per1kOutput() : model.per1kOutput();
        String prefix = model == null ? "" : "「" + model.displayName() + "」";
        if (in <= 0 && out <= 0) {
            return prefix + "当前模型不扣积分。";
        }
        return prefix + "每 1000 输入 token 扣 " + in + " 分，每 1000 输出 token 扣 " + out
                + " 分，单轮最低 " + minChargePerTurn() + " 分。";
    }

    public String explain() {
        return explain(null);
    }

    private long perThousand(long tokens, long creditsPer1k) {
        if (tokens <= 0 || creditsPer1k <= 0) {
            return 0;
        }
        return (tokens * creditsPer1k + 999) / 1000;
    }
}
