package com.webcode.assistant.workspace;

/**
 * 文件读取结果。
 *
 * @param path      相对路径
 * @param content   文本内容；二进制文件为 null
 * @param sizeBytes  磁盘上的真实字节数
 * @param truncated 是否因超过单次读取上限而被截断（前端与模型都必须知道这件事，
 *                  否则模型会基于半截代码给出错误结论）
 * @param binary    是否为二进制文件
 * @param language  Monaco 语言标识，用于前端高亮
 */
public record FileContent(
        String path,
        String content,
        long sizeBytes,
        boolean truncated,
        boolean binary,
        String language
) {
}
