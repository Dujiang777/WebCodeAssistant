package com.webcode.assistant.workspace.diff;

import java.util.List;

/**
 * 单个变更块。
 *
 * @param oldStart 原文件起始行号（1-based，0 表示空文件）
 * @param oldCount 原文件行数
 * @param newStart 新文件起始行号
 * @param newCount 新文件行数
 * @param lines    块内行，type 为 {@code ' '} / {@code '+'} / {@code '-'}
 */
public record Hunk(int oldStart, int oldCount, int newStart, int newCount, List<HunkLine> lines) {

    public int addedLines() {
        return (int) lines.stream().filter(line -> line.type() == '+').count();
    }

    public int removedLines() {
        return (int) lines.stream().filter(line -> line.type() == '-').count();
    }

    /** 该块在原文中的「期望内容」序列（上下文行 + 删除行）。 */
    public List<String> expectedOldLines() {
        return lines.stream()
                .filter(line -> line.type() != '+')
                .map(HunkLine::text)
                .toList();
    }
}
