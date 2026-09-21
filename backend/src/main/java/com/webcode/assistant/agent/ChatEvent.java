package com.webcode.assistant.agent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * 一条 SSE 事件。
 *
 * <p>线格式（前后端约定死），每个事件是一行 {@code data:}：
 * <pre>
 * data: {"seq":12,"type":"text","delta":"你好"}
 * data: {"seq":13,"type":"tool_call","name":"read_file","args":{"path":"src/main/java/com/demo/UserService.java"}}
 * data: {"seq":14,"type":"tool_result","name":"read_file","ok":true,"summary":"共 74 行"}
 * data: {"seq":15,"type":"patch","id":"8f14e45f-...","file":"src/main/java/com/demo/UserService.java","diff":"..."}
 * data: {"seq":16,"type":"error","message":"..."}
 * data: {"seq":17,"type":"done","messageId":"1234"}
 * </pre>
 *
 * <p><b>关于字段命名的两点说明：</b>
 * <ol>
 *   <li>会话内单调递增的序号字段叫 {@code seq} 而不是 {@code id}。因为 {@code patch} 事件的
 *       {@code id} 按约定是<b>补丁 uuid</b>，两者同名会互相覆盖。断线重连时把最后收到的
 *       {@code seq} 作为查询参数 {@code afterId} 传回即可回放。</li>
 *   <li>事件类型与字段名一旦发布就不再改动，前端按 {@code type} 分支。</li>
 * </ol>
 */
public record ChatEvent(long seq, String type, Map<String, Object> body) {

    public static final String TYPE_TEXT = "text";
    public static final String TYPE_TOOL_CALL = "tool_call";
    public static final String TYPE_TOOL_RESULT = "tool_result";
    public static final String TYPE_PATCH = "patch";
    /**
     * 回合结束时对回答里的引用做的校验结果。
     *
     * <p>单独发一条事件而不是塞进 {@code done}：前端要在文本渲染完成之后才能把
     * 引用标记成「不存在」，而 {@code done} 之后这一轮就整块被服务端版本替换了。
     */
    public static final String TYPE_CITATIONS = "citations";
    public static final String TYPE_ERROR = "error";
    public static final String TYPE_DONE = "done";

    public String toJson(ObjectMapper mapper) throws JsonProcessingException {
        ObjectNode node = mapper.createObjectNode();
        node.put("seq", seq);
        node.put("type", type);
        for (Map.Entry<String, Object> entry : body.entrySet()) {
            node.set(entry.getKey(), mapper.valueToTree(entry.getValue()));
        }
        return mapper.writeValueAsString(node);
    }
}
