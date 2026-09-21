package com.webcode.assistant.workspace.diff;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * unified diff 解析器。
 *
 * <p>刻意写得比较宽容，因为真实模型的输出五花八门：
 * <ul>
 *   <li>接受 {@code diff --git a/x b/x}、{@code index ...}、{@code new file mode} 等 git 头，直接跳过；</li>
 *   <li>接受缺少 {@code ---}/{@code +++} 的裸 hunk（此时由调用方提供的 file 参数补齐路径）；</li>
 *   <li>{@code @@ -1 +1 @@} 这种省略计数的写法按 1 行处理；</li>
 *   <li>{@code /dev/null} 与 {@code a/}、{@code b/} 前缀统一归一化，避免上层再写一遍字符串处理。</li>
 * </ul>
 *
 * <p>但宽容仅限「格式变体」：任何语义不清的情况一律抛 {@link ErrorCode#DIFF_INVALID}，
 * 绝不做猜测性修补 —— 猜错了会写坏用户的文件。
 */
public final class UnifiedDiffParser {

    private static final Pattern HUNK_HEADER =
            Pattern.compile("^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@.*$");
    private static final Pattern FILE_HEADER = Pattern.compile("^(---|\\+\\+\\+) ?(.*)$");
    private static final int MAX_HUNKS = 5000;

    private UnifiedDiffParser() {
    }

    /**
     * @param diffText 原始 diff 文本
     * @param fallbackPath diff 中缺少文件头时使用的路径（由调用方给出），可为 null
     * @return 多文件补丁；这里返回列表，由上层拒绝「一次改多个文件」的情况
     */
    public static List<FilePatch> parse(String diffText, String fallbackPath) {
        if (diffText == null || diffText.isBlank()) {
            throw new ApiException(ErrorCode.DIFF_INVALID, "补丁内容为空");
        }

        String[] rawLines = diffText.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        List<FilePatch> patches = new ArrayList<>();

        String oldPath = null;
        String newPath = null;
        boolean sawFileHeader = false;
        String currentHunkHeader = null;
        List<HunkLine> currentLines = new ArrayList<>();

        for (int i = 0; i < rawLines.length; i++) {
            String line = rawLines[i];

            Matcher hunkMatcher = HUNK_HEADER.matcher(line);
            if (hunkMatcher.matches()) {
                // 收尾上一个 hunk
                flushHunk(patches, oldPath, newPath, sawFileHeader, currentHunkHeader, currentLines, fallbackPath);
                currentHunkHeader = line;
                currentLines = new ArrayList<>();
                continue;
            }

            if (line.startsWith("@@")) {
                throw new ApiException(ErrorCode.DIFF_INVALID, "无法解析的变更块头: " + line);
            }

            if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode")
                    || line.startsWith("deleted file mode") || line.startsWith("old mode") || line.startsWith("new mode")
                    || line.startsWith("similarity index") || line.startsWith("dissimilarity index")
                    || line.startsWith("rename from") || line.startsWith("rename to") || line.startsWith("copy from")
                    || line.startsWith("copy to")) {
                continue;
            }

            if (line.startsWith("--- ") || line.startsWith("+++ ")) {
                // 新的文件段落开始前，先把上一个 hunk 落袋
                flushHunk(patches, oldPath, newPath, sawFileHeader, currentHunkHeader, currentLines, fallbackPath);
                currentHunkHeader = null;
                currentLines = new ArrayList<>();

                Matcher matcher = FILE_HEADER.matcher(line);
                if (!matcher.matches()) {
                    throw new ApiException(ErrorCode.DIFF_INVALID, "无法解析的文件头: " + line);
                }
                String path = cleanPath(matcher.group(2));
                if ("---".equals(matcher.group(1))) {
                    oldPath = "/dev/null".equals(path) ? null : path;
                    sawFileHeader = true;
                } else {
                    newPath = "/dev/null".equals(path) ? null : path;
                    sawFileHeader = true;
                }
                continue;
            }

            if (currentHunkHeader == null) {
                // hunk 之外的内容（空行、模型寒暄）忽略，不参与解析
                continue;
            }

            if (line.startsWith("\\")) {
                // "\ No newline at end of file"：不参与内容生成，
                // 换行处理统一由 applier 依据原文习惯决定。
                continue;
            }

            char type = line.isEmpty() ? ' ' : line.charAt(0);
            String text = line.isEmpty() ? "" : line.substring(1);
            switch (type) {
                case ' ', '+', '-' -> currentLines.add(new HunkLine(type, text));
                default -> {
                    // 不允许出现游离内容：宁可报错也不猜
                    throw new ApiException(ErrorCode.DIFF_INVALID, "变更块内出现非法行: " + abbreviate(line));
                }
            }
        }

        flushHunk(patches, oldPath, newPath, sawFileHeader, currentHunkHeader, currentLines, fallbackPath);

        if (patches.isEmpty()) {
            throw new ApiException(ErrorCode.DIFF_INVALID, "补丁中没有任何变更块（@@ ... @@）");
        }
        return patches;
    }

    private static void flushHunk(List<FilePatch> patches,
                                  String oldPath,
                                  String newPath,
                                  boolean sawFileHeader,
                                  String hunkHeader,
                                  List<HunkLine> lines,
                                  String fallbackPath) {
        if (hunkHeader == null) {
            return;
        }
        Matcher matcher = HUNK_HEADER.matcher(hunkHeader);
        if (!matcher.matches()) {
            throw new ApiException(ErrorCode.DIFF_INVALID, "无法解析的变更块头: " + hunkHeader);
        }
        int oldStart = Integer.parseInt(matcher.group(1));
        int oldCount = matcher.group(2) == null ? 1 : Integer.parseInt(matcher.group(2));
        int newStart = Integer.parseInt(matcher.group(3));
        int newCount = matcher.group(4) == null ? 1 : Integer.parseInt(matcher.group(4));

        Hunk hunk = new Hunk(oldStart, oldCount, newStart, newCount, lines);

        String effectiveOld = oldPath;
        String effectiveNew = newPath;
        if (!sawFileHeader) {
            if (fallbackPath == null || fallbackPath.isBlank()) {
                throw new ApiException(ErrorCode.DIFF_INVALID, "补丁缺少 ---/+++ 文件头，且未提供目标文件路径");
            }
            effectiveOld = fallbackPath;
            effectiveNew = fallbackPath;
        }

        FilePatch last = patches.isEmpty() ? null : patches.get(patches.size() - 1);
        if (last != null && java.util.Objects.equals(last.oldPath(), effectiveOld)
                && java.util.Objects.equals(last.newPath(), effectiveNew)) {
            if (last.hunks().size() >= MAX_HUNKS) {
                throw new ApiException(ErrorCode.DIFF_INVALID, "变更块数量超出上限");
            }
            List<Hunk> merged = new ArrayList<>(last.hunks());
            merged.add(hunk);
            patches.set(patches.size() - 1, new FilePatch(effectiveOld, effectiveNew, List.copyOf(merged)));
        } else {
            patches.add(new FilePatch(effectiveOld, effectiveNew, List.of(hunk)));
        }
    }

    /** 去掉 {@code a/}、{@code b/} 前缀与包裹引号。 */
    private static String cleanPath(String raw) {
        String path = raw == null ? "" : raw.trim();
        int tab = path.indexOf('\t');
        if (tab >= 0) {
            path = path.substring(0, tab).trim();
        }
        if (path.length() >= 2 && path.startsWith("\"") && path.endsWith("\"")) {
            path = path.substring(1, path.length() - 1);
        }
        if ("/dev/null".equals(path)) {
            return path;
        }
        if (path.startsWith("a/") || path.startsWith("b/")) {
            path = path.substring(2);
        }
        // git 有时会输出 b/src/x.java 这种带前缀的相对路径，也接受裸路径
        return path.replace('\\', '/');
    }

    private static String abbreviate(String line) {
        return line.length() > 60 ? line.substring(0, 60) + "..." : line;
    }
}
