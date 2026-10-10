package com.webcode.assistant.agent;

/**
 * 一次对话请求的完整入参。
 *
 * @param sessionId   会话 id
 * @param workspaceId 工作区 id
 * @param userId      发起人
 * @param content     用户消息正文
 * @param currentFile 编辑器当前打开的文件（相对路径），可为 null
 * @param selection   用户在编辑器里选中的片段，可为 null
 * @param mode        {@code deliver}（默认，少说话直接给结果）或 {@code teach}（讲清为什么）
 * @param modelKey    本轮指定使用的模型；null/空表示跟随用户默认 → 平台默认。
 *                    解析与回落逻辑全在 {@code ModelCatalogService.resolve} 里，
 *                    这一层不做任何「指定的模型不存在就报错」的判断 ——
 *                    用户上次选的模型被下架时，对话应该照常跑。
 */
public record AgentRequest(
        long sessionId,
        long workspaceId,
        long userId,
        String content,
        String currentFile,
        Selection selection,
        String mode,
        String modelKey
) {

    /** 交付模式：结论优先，不解释过程。 */
    public static final String MODE_DELIVER = "deliver";

    /** 教学模式：解释每次工具调用的动机与设计取舍。 */
    public static final String MODE_TEACH = "teach";

    /** 归一化模式取值，未知值一律退化为交付模式（宁可少说话，不要话痨）。 */
    public static String normalizeMode(String raw) {
        return MODE_TEACH.equalsIgnoreCase(raw == null ? "" : raw.trim()) ? MODE_TEACH : MODE_DELIVER;
    }

    public String normalizedMode() {
        return normalizeMode(mode);
    }

    /**
     * 本轮工具档。解释不绑工具；单文件改只给补丁/检索；查引用不给写盘；
     * 其余才上全套。工具出现在 schema 里，模型几乎总会先调用，这是慢的主因。
     */
    public enum ToolProfile {
        DIRECT,
        EDIT,
        SEARCH,
        FULL
    }

    public boolean directAnswer() {
        return toolProfile() == ToolProfile.DIRECT;
    }

    public ToolProfile toolProfile() {
        String text = content == null ? "" : content;
        boolean write = asksWrite(text);
        boolean search = asksSearch(text);
        boolean hasCode = (selection != null && !selection.isEmpty())
                || (currentFile != null && !currentFile.isBlank());
        if (write && search) {
            return ToolProfile.FULL;
        }
        if (write && hasCode) {
            return ToolProfile.EDIT;
        }
        if (search) {
            return ToolProfile.SEARCH;
        }
        if (hasCode) {
            return ToolProfile.DIRECT;
        }
        return ToolProfile.FULL;
    }

    private static boolean asksWrite(String text) {
        return containsAny(text, "改成", "改一下", "帮我改", "修复", "实现", "加上",
                "删除", "重构", "替换", "写成", "补丁", "新建", "新增", "注入",
                "写一个", "propose_patch");
    }

    private static boolean asksSearch(String text) {
        return containsAny(text, "谁在用", "调用方", "在哪", "找出", "搜索", "引用");
    }

    private static boolean containsAny(String text, String... needles) {
        for (String needle : needles) {
            if (text.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 选中片段。
     *
     * @param startLine 起始行（1-based）
     * @param endLine   结束行（1-based，含）
     * @param text      选中文本
     */
    public record Selection(Integer startLine, Integer endLine, String text) {

        public boolean isEmpty() {
            return (text == null || text.isBlank()) && startLine == null && endLine == null;
        }
    }
}
