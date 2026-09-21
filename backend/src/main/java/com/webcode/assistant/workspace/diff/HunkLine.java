package com.webcode.assistant.workspace.diff;

/**
 * diff 中的一行。
 *
 * @param type {@code ' '} 上下文 / {@code '+'} 新增 / {@code '-'} 删除
 * @param text 不含前缀符号的正文
 */
public record HunkLine(char type, String text) {

    public boolean isContext() {
        return type == ' ';
    }

    public boolean isAdded() {
        return type == '+';
    }

    public boolean isRemoved() {
        return type == '-';
    }
}
