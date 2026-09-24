package com.webcode.assistant.agent;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 会话级事件发布口。工具与 Agent 循环只依赖它，不直接碰 {@code SseEmitter}，
 * 这样「事件从哪来」和「事件怎么送到浏览器」彻底解耦，将来换成 WebSocket 也只改实现层。
 */
public class ChatEventPublisher {

    private final long sessionId;
    private final ChatEventHub.SessionChannel channel;

    ChatEventPublisher(long sessionId, ChatEventHub.SessionChannel channel) {
        this.sessionId = sessionId;
        this.channel = channel;
    }

    public long sessionId() {
        return sessionId;
    }

    /** 模型输出的一个增量片段。 */
    public void text(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
        }
        channel.publish(ChatEvent.TYPE_TEXT, Map.of("delta", delta));
    }

    /** 工具调用开始（在工具方法体开头发出，因此前端能立刻看到「正在读哪个文件」）。 */
    public void toolCall(String name, Map<String, Object> args) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("args", args == null ? Map.of() : args);
        channel.publish(ChatEvent.TYPE_TOOL_CALL, body);
    }

    /** 工具调用结束。{@code ok=false} 时 {@code summary} 就是失败原因。 */
    public void toolResult(String name, boolean ok, String summary) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("ok", ok);
        body.put("summary", summary == null ? "" : summary);
        channel.publish(ChatEvent.TYPE_TOOL_RESULT, body);
    }

    /** 补丁已生成，等待用户在前端确认。{@code id} 是补丁 uuid。 */
    public void patch(String patchId, String file, String diff) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", patchId);
        body.put("file", file);
        body.put("diff", diff);
        channel.publish(ChatEvent.TYPE_PATCH, body);
    }

    public void error(String message) {
        channel.publish(ChatEvent.TYPE_ERROR, Map.of("message", message == null ? "未知错误" : message));
    }

    /**
     * 回答里引用的校验结果。
     *
     * @param citations 每条包含 file / line / endLine / valid / reason
     */
    public void citations(java.util.List<com.webcode.assistant.context.Citation> citations) {
        channel.publish(ChatEvent.TYPE_CITATIONS,
                Map.of("items", citations == null ? java.util.List.of() : citations));
    }

    public void done(long messageId) {
        channel.publish(ChatEvent.TYPE_DONE, Map.of("messageId", String.valueOf(messageId)));
    }

    /**
     * Agent 工位状态（功能 13）。
     *
     * <p>整块状态用一次事件推完，而不是推增量 —— 工位是「此刻的样子」，
     * 增量会让前端不得不在本地重演一遍状态机，多一处能算错的地方。
     */
    public void desk(Map<String, Object> snapshot) {
        channel.publish(ChatEvent.TYPE_DESK, snapshot == null ? Map.of() : snapshot);
    }

    /**
     * 工具闸门：某次工具调用被拦下，等待人工放行（功能 14）。
     *
     * @param gateId   闸门 uuid，前端 approve / reject 时要带回来
     * @param tool     被拦下的工具名
     * @param intent   人话描述「它想干什么」
     * @param args     被拦下的参数（前端可编辑）
     * @param editable true 表示允许改参数后放行（写操作恒为 true）
     * @param reason   为什么会拦下（例如「写盘操作」「检索范围覆盖整个工作区」）
     * @param expiresAt 超时时刻（epoch millis），到点未处理视为拒绝
     */
    public void toolGate(String gateId, String tool, String intent, Map<String, Object> args,
                         boolean editable, String reason, long expiresAt) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("gateId", gateId);
        body.put("tool", tool);
        body.put("intent", intent == null ? "" : intent);
        body.put("args", args == null ? Map.of() : args);
        body.put("editable", editable);
        body.put("reason", reason == null ? "" : reason);
        body.put("expiresAt", expiresAt);
        channel.publish(ChatEvent.TYPE_TOOL_GATE, body);
    }

    /** 闸门处理结果：前端收起等待卡片，工具在服务端继续执行。 */
    public void gateResolved(String gateId, String decision, String note) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("gateId", gateId);
        body.put("decision", decision == null ? "approved" : decision);
        body.put("note", note == null ? "" : note);
        channel.publish(ChatEvent.TYPE_GATE_RESOLVED, body);
    }
}
