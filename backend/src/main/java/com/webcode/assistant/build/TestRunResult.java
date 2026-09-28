package com.webcode.assistant.build;

import java.util.List;

/**
 * 一次测试运行的结果。「测试失败驱动改代码」的事实来源。
 *
 * <p>状态语义与 {@link BuildResult} 完全一致（ok / failed / timeout / unavailable / disabled），
 * 同样坚持「没跑 ≠ 通过」：找不到构建工具时是 {@code unavailable}，绝不能混进 {@code ok}。
 *
 * @param status      ok / failed / timeout / unavailable / disabled
 * @param buildSystem maven / gradle / 未知
 * @param command     实际执行的命令行（便于复现）
 * @param exitCode    退出码，未执行为 null
 * @param durationMs  耗时
 * @param output      原始输出（裁剪保留尾部；失败详情通常在末尾）
 * @param totals      用例统计（Maven surefire 能给出总数；Gradle 无标准聚合时为 null）
 * @param failures    解析出的失败用例（类名 / 方法 / 行号 / 失败信息）
 * @param issues      测试代码编译不过时的结构化诊断 —— 「测试失败」最常见的形式之一
 *                    是补丁改了主代码却把测试代码改崩，surefire 根本没机会跑，
 *                    此时 failures 为空、issues 给出编译错误位置，驱动模型先修编译
 * @param note        给用户看的补充说明
 */
public record TestRunResult(
        String status,
        String buildSystem,
        String command,
        Integer exitCode,
        long durationMs,
        String output,
        Totals totals,
        List<TestFailure> failures,
        List<CompileIssue> issues,
        String note
) {

    public static final String OK = "ok";
    public static final String FAILED = "failed";
    public static final String TIMEOUT = "timeout";
    public static final String UNAVAILABLE = "unavailable";
    public static final String DISABLED = "disabled";

    public static TestRunResult skipped(String status, String note) {
        return new TestRunResult(status, "未知", "", null, 0L, "", null, List.of(), List.of(), note);
    }

    /** 用例统计。counts 可能不含 skipped，用 null 表示「未知」。 */
    public record Totals(int run, int failures, int errors, Integer skipped) {

        public int problemCount() {
            return failures + errors;
        }
    }

    /**
     * 一个失败用例。
     *
     * @param testClass 测试类简单名
     * @param method    方法名（部分框架输出里可能拿不到，为 null）
     * @param line      失败断言所在行号（能解析到时）
     * @param message   失败信息原文（expected ... but was ... 等）
     */
    public record TestFailure(String testClass, String method, Integer line, String message) {

        /** 展示名：类.方法，拿不到方法时退化为类名。 */
        public String displayName() {
            return method == null ? testClass : testClass + "." + method;
        }
    }
}
