package com.webcode.assistant.context;

/**
 * 回答里的一处引用。
 *
 * @param file    相对工作区根的文件路径
 * @param line    起始行（可能为 null，表示只给了文件没给行号）
 * @param endLine 结束行（仅范围引用有值）
 * @param valid   是否通过校验（文件存在且行号落在范围内）
 * @param reason  校验不通过的原因，通过时为 null
 */
public record Citation(String file, Integer line, Integer endLine, boolean valid, String reason) {

    public String label() {
        if (line == null) {
            return file;
        }
        if (endLine != null && !endLine.equals(line)) {
            return file + ":" + line + "-" + endLine;
        }
        return file + ":" + line;
    }
}
