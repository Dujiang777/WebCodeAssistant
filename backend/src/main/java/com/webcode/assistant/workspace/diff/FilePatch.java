package com.webcode.assistant.workspace.diff;

import java.util.List;

/**
 * 解析后的 unified diff 模型。
 *
 * @param oldPath 原文件路径；新建文件时为 {@code null}（对应 {@code /dev/null}）
 * @param newPath 目标文件路径；删除文件时为 {@code null}
 * @param hunks   变更块，按出现顺序
 */
public record FilePatch(String oldPath, String newPath, List<Hunk> hunks) {

    public boolean createsFile() {
        return oldPath == null;
    }

    public boolean deletesFile() {
        return newPath == null;
    }

    /** patch 实际作用的目标路径（优先新路径，删除场景回退到旧路径）。 */
    public String targetPath() {
        return newPath != null ? newPath : oldPath;
    }

    public int addedLines() {
        return hunks.stream().mapToInt(Hunk::addedLines).sum();
    }

    public int removedLines() {
        return hunks.stream().mapToInt(Hunk::removedLines).sum();
    }
}
