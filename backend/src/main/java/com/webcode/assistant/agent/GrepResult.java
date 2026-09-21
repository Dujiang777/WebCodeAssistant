package com.webcode.assistant.agent;

import java.util.List;

/**
 * 代码搜索结果。
 *
 * @param engine    实际使用的引擎：{@code ripgrep} 或 {@code java}
 * @param truncated 是否因为达到条数上限而被截断（必须告诉模型，否则它会以为「只有这些」）
 */
public record GrepResult(String pattern, List<GrepMatch> matches, boolean truncated, String engine, String note) {

    public static GrepResult empty(String pattern, String engine, String note) {
        return new GrepResult(pattern, List.of(), false, engine, note);
    }

    public int count() {
        return matches.size();
    }

    /**
     * 单条命中。
     *
     * @param file 相对工作区根的路径
     * @param line 行号（1-based）
     * @param text 该行原文，过长会被截断
     */
    public record GrepMatch(String file, int line, String text) {
    }
}
