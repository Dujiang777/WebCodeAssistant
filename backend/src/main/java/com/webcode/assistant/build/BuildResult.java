package com.webcode.assistant.build;

import java.util.List;

/**
 * 一次编译验证的结果。
 *
 * <p>{@code status} 的五个取值都有明确含义，前端据此决定展示什么 ——
 * 尤其 {@code unavailable} / {@code disabled} 必须与 {@code ok} 区分开：
 * 「没编译」和「编译通过」是完全不同的两件事，把它们混在一起就是在骗用户。
 *
 * @param status      ok / failed / timeout / unavailable / disabled
 * @param buildSystem maven / gradle / 未知
 * @param command     实际执行的命令行（便于用户复现）
 * @param exitCode    退出码，未执行时为 null
 * @param durationMs  耗时
 * @param output      编译器输出（已裁剪，保留尾部）
 * @param issues      解析出的结构化诊断，可直接点击跳转
 * @param note        给用户看的补充说明（为什么跳过、为什么超时等）
 */
public record BuildResult(
        String status,
        String buildSystem,
        String command,
        Integer exitCode,
        long durationMs,
        String output,
        List<CompileIssue> issues,
        String note
) {

    public static final String OK = "ok";
    public static final String FAILED = "failed";
    public static final String TIMEOUT = "timeout";
    public static final String UNAVAILABLE = "unavailable";
    public static final String DISABLED = "disabled";

    public boolean isSuccess() {
        return OK.equals(status);
    }

    public static BuildResult skipped(String status, String note) {
        return new BuildResult(status, "未知", "", null, 0L, "", List.of(), note);
    }
}
