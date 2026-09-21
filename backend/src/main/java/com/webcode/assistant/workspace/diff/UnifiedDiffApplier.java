package com.webcode.assistant.workspace.diff;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;

import java.util.ArrayList;
import java.util.List;

/**
 * unified diff 应用器。
 *
 * <p>设计取舍：
 * <ul>
 *   <li><b>不做 fuzz 行内容匹配</b>。hunk 里的上下文行与删除行必须逐字符匹配原文，
 *       否则说明模型看到的文件版本已经过期 —— 这时正确做法是拒绝并让模型重新读取，
 *       而不是「猜一个大概的位置」把代码改坏。</li>
 *   <li><b>允许行号漂移</b>。hunk 头里的行号只作为起始搜索点；如果在附近能<b>精确</b>匹配到
 *       整段上下文，就采用实际位置。这解决了「同一轮里模型连续改同一文件导致行号偏移」的问题。</li>
 *   <li><b>保留原文换行风格</b>。原文件是 CRLF 就仍写 CRLF，不因一次补丁把整个文件的换行风格改掉。</li>
 * </ul>
 */
public final class UnifiedDiffApplier {

    /** 行号漂移时向前/向后搜索的最大距离。 */
    private static final int SEARCH_WINDOW = 2000;

    private UnifiedDiffApplier() {
    }

    /**
     * 把单个文件补丁应用到原文上。
     *
     * @param original  原文件内容；新建文件时传 {@code null} 或空串
     * @param filePatch 已解析的补丁
     * @return 应用后的文件内容
     */
    public static String apply(String original, FilePatch filePatch) {
        String newline = detectNewline(original);

        if (filePatch.createsFile()) {
            if (original != null && !original.isEmpty()) {
                throw new ApiException(ErrorCode.DIFF_CONFLICT,
                        "补丁声明新建文件，但目标已存在且有内容: " + filePatch.targetPath());
            }
            return render(collectAddedLines(filePatch, true), newline, true);
        }

        if (original == null) {
            throw new ApiException(ErrorCode.DIFF_CONFLICT, "目标文件不存在: " + filePatch.targetPath());
        }

        boolean endsWithNewline = !original.isEmpty() && (original.endsWith("\n") || original.endsWith("\r"));

        // 统一成 LF 处理后，最后再还原换行风格
        String normalized = original.replace("\r\n", "\n").replace('\r', '\n');
        List<String> lines = new ArrayList<>(List.of(normalized.split("\n", -1)));
        // split 在文末换行时会多产生一个空元素，代表「文件以换行结束」，
        // 这里保留它参与行号计算（与 diff 行号语义一致）。
        List<String> working = new ArrayList<>(lines);

        int appliedOffset = 0;

        for (Hunk hunk : filePatch.hunks()) {
            List<String> expected = hunk.expectedOldLines();
            int expectedStart = Math.max(0, hunk.oldStart() - 1);

            int position = locate(working, expected, expectedStart + appliedOffset);
            if (position < 0) {
                position = locate(working, expected, expectedStart);
            }
            if (position < 0) {
                throw new ApiException(ErrorCode.DIFF_CONFLICT,
                        "补丁上下文与当前文件不匹配（" + filePatch.targetPath() + " 第 " + hunk.oldStart()
                                + " 行附近）。文件可能已被修改，请让模型重新读取后再生成补丁。");
            }

            working = splice(working, position, hunk);
            appliedOffset = position + hunk.newCount() - hunk.oldStart();
        }

        if (filePatch.deletesFile()) {
            return "";
        }

        // working 的最后一个元素若为空串，表示原文以换行结尾；据此还原
        String joined = render(working, "\n", endsWithNewline);
        return "\n".equals(newline) ? joined : joined.replace("\n", newline);
    }

    /** 在期望位置精确匹配整段上下文；失败则在同一方向的小窗口内搜索。 */
    private static int locate(List<String> fileLines, List<String> expected, int start) {
        if (expected.isEmpty()) {
            return Math.clamp(start, 0, fileLines.size());
        }
        if (matchesAt(fileLines, expected, start)) {
            return start;
        }
        int lower = Math.max(0, start - SEARCH_WINDOW);
        int upper = Math.min(fileLines.size() - expected.size(), start + SEARCH_WINDOW);
        // 由近及远地找，避免在重复代码块里跳得太远
        for (int distance = 1; distance <= SEARCH_WINDOW; distance++) {
            int forward = start + distance;
            if (forward <= upper && matchesAt(fileLines, expected, forward)) {
                return forward;
            }
            int backward = start - distance;
            if (backward >= lower && matchesAt(fileLines, expected, backward)) {
                return backward;
            }
        }
        return -1;
    }

    private static boolean matchesAt(List<String> fileLines, List<String> expected, int start) {
        if (start < 0 || start + expected.size() > fileLines.size()) {
            return false;
        }
        for (int i = 0; i < expected.size(); i++) {
            if (!fileLines.get(start + i).equals(expected.get(i))) {
                return false;
            }
        }
        return true;
    }

    /** 用 hunk 的结果替换原文中被覆盖的那一段。 */
    private static List<String> splice(List<String> fileLines, int position, Hunk hunk) {
        List<String> result = new ArrayList<>(fileLines.subList(0, position));
        for (HunkLine line : hunk.lines()) {
            switch (line.type()) {
                case ' ' -> result.add(line.text());
                case '+' -> result.add(line.text());
                case '-' -> {
                    // 删除行不进入结果
                }
                default -> throw new ApiException(ErrorCode.DIFF_INVALID, "非法行类型: " + line.type());
            }
        }
        int consumed = hunk.expectedOldLines().size();
        result.addAll(fileLines.subList(position + consumed, fileLines.size()));
        return result;
    }

    private static List<String> collectAddedLines(FilePatch filePatch, boolean ignoreContext) {
        List<String> result = new ArrayList<>();
        for (Hunk hunk : filePatch.hunks()) {
            for (HunkLine line : hunk.lines()) {
                if (line.isAdded() || (line.isContext() && !ignoreContext)) {
                    result.add(line.text());
                }
            }
        }
        return result;
    }

    /**
     * 把行列表还原成文本。{@code lines} 末尾的空串是「以换行结尾」的标记，
     * 用 {@code endsWithNewline} 统一控制，避免重复追加换行。
     */
    private static String render(List<String> lines, String newline, boolean endsWithNewline) {
        List<String> effective = new ArrayList<>(lines);
        boolean trailingMarker = !effective.isEmpty() && effective.get(effective.size() - 1).isEmpty();
        if (trailingMarker) {
            effective.remove(effective.size() - 1);
        }
        if (effective.isEmpty()) {
            return "";
        }
        String body = String.join(newline, effective);
        boolean newlineAtEnd = endsWithNewline || trailingMarker;
        return newlineAtEnd ? body + newline : body;
    }

    private static String detectNewline(String original) {
        if (original == null) {
            return "\n";
        }
        return original.contains("\r\n") ? "\r\n" : "\n";
    }
}
