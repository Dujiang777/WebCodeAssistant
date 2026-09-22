package com.webcode.assistant.terminal;

/**
 * 一次终端命令的执行结果。
 *
 * @param command    实际执行的命令串
 * @param exitCode   退出码（超时被杀时为 null）
 * @param durationMs 耗时
 * @param output     合并的 stdout + stderr（UTF-8，可能被截断）
 * @param timedOut   是否超时被杀
 * @param truncated  输出是否被截断
 */
public record TerminalResult(
        String command,
        Integer exitCode,
        long durationMs,
        String output,
        boolean timedOut,
        boolean truncated) {
}
