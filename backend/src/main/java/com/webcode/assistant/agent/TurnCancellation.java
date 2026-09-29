package com.webcode.assistant.agent;

import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 「用户点了停止」的登记处（按会话）。
 *
 * <p>为什么是进程内 Map 而不是数据库列：取消信号的生命周期就是一轮对话，
 * 只有一个用途 —— 让正在跑的工具循环尽快看到它。重启丢掉也无妨（回合本来也没了）。
 *
 * <p>时序约定：
 * <ul>
 *   <li>{@link #begin}：回合启动时调用，清掉上一轮可能残留的标志（幂等）；</li>
 *   <li>{@link #cancel}：REST 取消端点调用。即使此时回合已经自然结束，
 *       置位也无害 —— 标志会在下一轮 begin 时被清掉；</li>
 *   <li>{@link #isCanceled}：AgentToolbox 在每个工具边界上轮询的检查点。</li>
 * </ul>
 *
 * <p>生效边界：模型正在流式生成文本时插不进检查（HTTP 响应无法半途掐断），
 * 但工具执行 —— grep、读文件、构建 —— 是耗时的主要来源，它们都会在<b>下一个工具边界</b>
 * 立即终止。配合前端「停止后忽略后续增量」，用户感知就是即时的。
 */
@Component
public class TurnCancellation {

    private final Set<Long> canceled = ConcurrentHashMap.newKeySet();

    /** 回合启动：清掉上一轮残留的取消标志。 */
    public void begin(long sessionId) {
        canceled.remove(sessionId);
    }

    /** 用户请求停止当前会话正在跑的回合。回合不在跑时调用无害。 */
    public void cancel(long sessionId) {
        canceled.add(sessionId);
    }

    /** 工具边界检查：本会话的当前回合是否被用户停止。 */
    public boolean isCanceled(long sessionId) {
        return canceled.contains(sessionId);
    }
}
