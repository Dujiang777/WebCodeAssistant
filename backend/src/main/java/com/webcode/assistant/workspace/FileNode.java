package com.webcode.assistant.workspace;

import java.util.List;

/**
 * 文件树节点。目录带 {@code children}，文件为 null。
 *
 * @param path     相对工作区根的路径，统一使用 {@code /}
 * @param name     展示名
 * @param type     {@code file} / {@code dir}
 * @param size     文件字节数；目录为 null
 * @param children 子节点（目录按 目录优先 + 名称字典序 排列）
 */
public record FileNode(String path, String name, String type, Long size, List<FileNode> children) {

    public static FileNode file(String path, String name, long size) {
        return new FileNode(path, name, "file", size, null);
    }

    public static FileNode dir(String path, String name, List<FileNode> children) {
        return new FileNode(path, name, "dir", null, children);
    }
}
