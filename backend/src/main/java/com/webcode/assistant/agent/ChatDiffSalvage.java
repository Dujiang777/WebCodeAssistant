package com.webcode.assistant.agent;

/**
 * 把模型误贴进对话的 unified diff 抽出来。
 *
 * <p>有的模型（尤其自带 Key 的快模型）不调 {@code propose_patch}，
 * 把补丁写成 {@code ```diff} 或一长串 {@code --- a/}。没有确认卡 = 等于没改。
 */
final class ChatDiffSalvage {

    private ChatDiffSalvage() {
    }

    /** 优先围栏，其次第一处 {@code --- }。抽不出时返回 null。 */
    static String extract(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        int cursor = 0;
        while (true) {
            int open = raw.indexOf("```", cursor);
            if (open < 0) {
                break;
            }
            int lineEnd = raw.indexOf('\n', open);
            if (lineEnd < 0) {
                break;
            }
            int close = raw.indexOf("```", lineEnd);
            if (close < 0) {
                String tail = raw.substring(lineEnd + 1).strip();
                return looksLike(tail) ? tail : null;
            }
            String body = raw.substring(lineEnd + 1, close);
            if (looksLike(body)) {
                return body.strip();
            }
            cursor = close + 3;
        }
        int start = raw.indexOf("--- ");
        if (start < 0) {
            return null;
        }
        String rest = raw.substring(start).strip();
        return looksLike(rest) ? rest : null;
    }

    static boolean looksLike(String diff) {
        if (diff == null || diff.isBlank()) {
            return false;
        }
        return diff.contains("@@")
                && (diff.contains("--- ") || diff.contains("+++ ") || diff.contains("diff --git"));
    }

    /** 去掉围栏和裸 diff，留给用户看的说明。 */
    static String strip(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String out = raw.replaceAll("(?is)```(?:diff|patch|udiff)?\\s*\\r?\\n.*?```", "");
        int fence = out.indexOf("```");
        if (fence >= 0) {
            String after = out.substring(fence);
            if (looksLike(after) || after.contains("@@") || after.contains("--- ")) {
                out = out.substring(0, fence);
            }
        }
        int start = indexOfLine(out, "--- ");
        if (start >= 0 && looksLike(out.substring(start))) {
            out = out.substring(0, start);
        }
        return out.strip();
    }

    private static int indexOfLine(String text, String prefix) {
        if (text.startsWith(prefix)) {
            return 0;
        }
        int at = text.indexOf("\n" + prefix);
        return at < 0 ? -1 : at + 1;
    }
}
