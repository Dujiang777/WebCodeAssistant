package com.webcode.assistant.agent;

import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 按会话登记「这一轮还算不算数」。
 *
 * <p>用<b>代次</b>而不是一颗布尔：新问题一来就 {@link #begin} 把代次加一，
 * 上一轮在下一个工具边界会看到自己的代次过期，立刻停。若只靠一颗
 * 「已取消」旗，新回合的 begin 会把旗清掉，旧循环又活过来 ——
 * 前端就会出现「刚问解释，计划里却在写上一轮的斐波那契」。
 *
 * <p>时序：
 * <ul>
 *   <li>{@link #begin}：新回合启动，返回本轮代次；旧代次立即作废；</li>
 *   <li>{@link #cancel}：用户点停止，只杀当前代次；</li>
 *   <li>{@link #isCanceled}(session, gen)：用户停了，或这轮已经被更新的问题取代。</li>
 * </ul>
 */
@Component
public class TurnCancellation {

    private static final class State {
        final AtomicLong generation = new AtomicLong(0);
        volatile boolean userCanceled;
    }

    private final ConcurrentHashMap<Long, State> states = new ConcurrentHashMap<>();

    /** 新回合启动。返回本轮代次；上一轮的代次从此作废。 */
    public long begin(long sessionId) {
        State state = states.computeIfAbsent(sessionId, id -> new State());
        state.userCanceled = false;
        return state.generation.incrementAndGet();
    }

    /** 用户请求停止当前会话正在跑的回合。回合不在跑时调用无害。 */
    public void cancel(long sessionId) {
        State state = states.computeIfAbsent(sessionId, id -> new State());
        state.userCanceled = true;
    }

    /** 只看用户有没有点停止（给取消接口做即时判断）。 */
    public boolean isCanceled(long sessionId) {
        State state = states.get(sessionId);
        return state != null && state.userCanceled;
    }

    /** 工具边界 / 事件发布：这轮是不是已经被停掉或被新问题取代。 */
    public boolean isCanceled(long sessionId, long generation) {
        State state = states.get(sessionId);
        if (state == null) {
            return false;
        }
        return state.userCanceled || state.generation.get() != generation;
    }

    /** 被更新的问题取代（不是用户点停止）。旧轮收尾时不该再往 SSE 推 done。 */
    public boolean isStale(long sessionId, long generation) {
        State state = states.get(sessionId);
        return state == null || state.generation.get() != generation;
    }
}
