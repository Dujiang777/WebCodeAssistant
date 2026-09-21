package com.webcode.assistant.agent;

import java.util.List;

/**
 * 补丁影响面（Blast radius）。
 *
 * <p>为什么需要它：只看 diff 用户只能判断「改得对不对」，判断不了「敢不敢点应用」。
 * 后者取决于影响面 —— 改的是没人用的工具方法，还是被 37 处调用的鉴权入口，风险差着量级。
 *
 * <p>实现上刻意不走完整 PSI/编译期符号解析：文本级引用搜索（grep 类名 + 被改方法名）
 * 在 Java 项目里的召回率已经足够支撑一个「风险提示」，而成本是毫秒级。
 * 宁可给一个 95% 准的提示，也不要为了 100% 准确让用户等一次编译。
 *
 * @param file             被改的文件
 * @param declaredType     文件里声明的主类型（class/interface/record/enum 的名字）
 * @param changedMembers   补丁触碰到的成员名（方法、字段、构造器）
 * @param addedLines       新增行数
 * @param removedLines     删除行数
 * @param callers          引用该类型的位置（不含被改文件自身、不含测试）
 * @param tests            引用该类型的测试位置
 * @param risks            命中的风险项
 * @param riskLevel        high / medium / low
 * @param headline         一句话结论，给卡片头部用
 * @param callersTruncated 引用列表是否被截断（grep 有条数上限）
 */
public record BlastRadius(
        String file,
        String declaredType,
        List<String> changedMembers,
        int addedLines,
        int removedLines,
        List<Ref> callers,
        List<Ref> tests,
        List<Risk> risks,
        String riskLevel,
        String headline,
        boolean callersTruncated
) {

    public static final String LEVEL_HIGH = "high";
    public static final String LEVEL_MEDIUM = "medium";
    public static final String LEVEL_LOW = "low";

    /**
     * 一处引用。
     *
     * @param kind {@code type}（引用类型名）/ {@code method}（引用被改的方法）/ {@code test}
     */
    public record Ref(String file, int line, String text, String kind) {
    }

    /** 一条风险。{@code level} 取 high / medium / low。 */
    public record Risk(String label, String level, String reason) {
    }
}
