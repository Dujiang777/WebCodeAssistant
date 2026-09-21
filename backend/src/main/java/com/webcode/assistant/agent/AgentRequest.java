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
 */
public record AgentRequest(
        long sessionId,
        long workspaceId,
        long userId,
        String content,
        String currentFile,
        Selection selection,
        String mode
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
