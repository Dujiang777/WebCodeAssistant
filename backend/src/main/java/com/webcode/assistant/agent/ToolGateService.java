package com.webcode.assistant.agent;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 工具级人工闸门 —— 功能 14：把「审 diff」提前到「审意图」。
 *
 * <p>Agent 每次要动写操作（起草补丁、跑测试）或做大范围检索时，<b>在真正执行之前</b>挂起，
 * 推一条 {@code tool_gate} 事件，人可以在前端改参数、改路径、直接拒绝，然后放行。
 * 与「先生成完再 reject」的区别：模型还没烧掉那一步的 token，人也不用读一份已经写完的 diff。
 *
 * <p><b>三条设计取舍：</b>
 * <ol>
 *   <li>阻塞发生在 Agent 的<b>虚拟线程</b>上（{@code CountDownLatch.await} 对虚拟线程只是 park），
 *       不会占用 Tomcat 线程，也不会拖慢同一用户的文件浏览等请求；</li>
 *   <li><b>超时自动放行</b>而不是自动拒绝：闸门的目的是「给你机会插话」，不是让工作流停摆。
 *       人去开会了却让 Agent 卡死在那里，体验比放行糟糕得多。超时放行会在事件里标注
 *       {@code timedOut=true}，且在行为时间线上留痕 —— 事后可审计；</li>
 *   <li>参数只允许在<b>工具自己声明的键</b>上覆盖（不新增键）：前端拿不到一个能构造任意调用的通道，
 *       路径越界依然由各工具/文件服务的三层校验兜底。</li>
 * </ol>
 */
@Service
public class ToolGateService {

    private static final Logger log = LoggerFactory.getLogger(ToolGateService.class);

    /** 全放行：适合信任模式 / 自动化流程。 */
    public static final String POLICY_OFF = "off";

    /** 默认：拦写操作（起草补丁、跑测试）。 */
    public static final String POLICY_WRITES = "writes";

    /** 严格：在写操作之外，再拦「范围过大」的检索。 */
    public static final String POLICY_STRICT = "strict";

    /** 等待人工审批的上限；到点自动放行（见类注释第 2 条）。 */
    private static final Duration APPROVAL_TIMEOUT = Duration.ofSeconds(20);

    /** 少于这个长度的正则在整仓检索基本等于「什么都搜」，属于要拦的宽泛查询。 */
    private static final int BROAD_PATTERN_LENGTH = 4;

    private final ChatEventHub hub;

    /** sessionId → 策略（默认 writes）。 */
    private final Map<Long, String> policies = new ConcurrentHashMap<>();

    /** gateId → 等待中的闸门。同一会话同时最多一个（Agent 是单线程循环，不会并发申请）。 */
    private final Map<String, Pending> gates = new ConcurrentHashMap<>();

    public ToolGateService(ChatEventHub hub) {
        this.hub = hub;
    }

    // ------------------------------------------------------------ 策略

    public String policyOf(long sessionId) {
        return policies.getOrDefault(sessionId, POLICY_WRITES);
    }

    public String setPolicy(long sessionId, String policy) {
        String normalized = normalizePolicy(policy);
        policies.put(sessionId, normalized);
        return normalized;
    }

    public static String normalizePolicy(String policy) {
        if (policy == null) {
            return POLICY_WRITES;
        }
        return switch (policy.trim().toLowerCase(java.util.Locale.ROOT)) {
            case POLICY_OFF, "trust", "auto" -> POLICY_OFF;
            case POLICY_STRICT, "paranoid" -> POLICY_STRICT;
            default -> POLICY_WRITES;
        };
    }

    /**
     * 这个工具调用要不要拦？返回 {@code null} 表示放行，否则返回拦截理由（给用户看的中文）。
     *
     * <p>判定只看「意图 + 参数」，不看工具实现 —— 所以新增工具时只要在这里补一条规则，
     * 不用改任何工具方法。
     */
    public String reasonToGate(long sessionId, String tool, Map<String, Object> args) {
        String policy = policyOf(sessionId);
        if (POLICY_OFF.equals(policy)) {
            return null;
        }
        return switch (tool) {
            case "propose_patch" -> "写操作：这一步会生成一个待应用的代码补丁";
            case "run_tests" -> "外部进程：会在工作区里真实执行构建 / 测试命令";
            case "grep" -> POLICY_STRICT.equals(policy) ? broadGrepReason(args) : null;
            case "semantic_search" -> POLICY_STRICT.equals(policy) ? "严格模式：语义检索会调用 embedding 模型" : null;
            default -> null;
        };
    }

    /** 只有「扫全仓」或「模式宽到没有意义」才拦 —— 精确检索是 Agent 的日常动作，拦它等于拦工作。 */
    private static String broadGrepReason(Map<String, Object> args) {
        String scope = args == null ? null : String.valueOf(args.getOrDefault("path", ""));
        String pattern = args == null ? null : String.valueOf(args.getOrDefault("pattern", ""));
        boolean wholeRepo = scope == null || scope.isBlank() || ".".equals(scope) || "/".equals(scope);
        if (wholeRepo) {
            return "检索范围覆盖整个工作区（严格模式）";
        }
        if (pattern != null && !pattern.isBlank() && pattern.length() < BROAD_PATTERN_LENGTH) {
            return "检索模式过于宽泛「" + pattern + "」（严格模式）";
        }
        return null;
    }

    // ------------------------------------------------------------ 闸门

    /**
     * 一次等待放行的结果。
     *
     * <p>{@code changedKeys} 区分「人工真的改了」与「参数只是拿来展示」——
     * 这一点很关键：事件里的 diff 是<b>缩写版</b>（避免整份 diff 走两遍事件流），
     * 如果放行后无脑用事件参数，缩写版就会把补丁写坏。所以只有 {@code changedKeys} 里的键
     * 才用人工值，其余一律回到工具原始入参。
     */
    public record GateDecision(boolean approved, Map<String, Object> args, String note, boolean timedOut,
                               java.util.Set<String> changedKeys) {

        public static GateDecision passThrough(Map<String, Object> args) {
            return new GateDecision(true, args, null, false, java.util.Set.of());
        }

        public boolean changed(String key) {
            return changedKeys != null && changedKeys.contains(key);
        }

        /** 取参数：只有人工确实改过才用新值，否则用原始值。 */
        public String value(String key, String original) {
            if (!changed(key)) {
                return original;
            }
            String updated = raw(key);
            return updated == null || updated.isBlank() ? original : updated;
        }

        /** 取参数（键名可能为 null 的工具，例如 list_dir 的 path）。 */
        public String raw(String key) {
            Object value = args == null ? null : args.get(key);
            return value == null ? null : String.valueOf(value);
        }
    }

    /**
     * 阻塞等待人工放行。调用方（工具方法）拿到结果后应当用 {@code decision.value(key, 原值)} 取参数，
     * 而不是继续用自己入参里的原值 —— 否则「改参数放行」就是假的。
     */
    public GateDecision waitForApproval(long sessionId, long workspaceId, String tool,
                                        Map<String, Object> args, String reason) {
        Pending pending = new Pending(UUID.randomUUID().toString(), sessionId, workspaceId, tool,
                args == null ? Map.of() : args, reason, Instant.now(), Instant.now().plus(APPROVAL_TIMEOUT));
        gates.put(pending.gateId, pending);

        publishGate(pending);
        log.info("闸门 {} 拦下工具 {}（session={}，理由：{}）", pending.gateId, tool, sessionId, reason);

        boolean clocked;
        try {
            clocked = pending.latch.await(APPROVAL_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            gates.remove(pending.gateId);
            // 线程被中断（例如用户直接删了会话）→ 当作拒绝，让模型自己收敛
            return new GateDecision(false, pending.args, "审批被中断", false, java.util.Set.of());
        }
        gates.remove(pending.gateId);

        if (!clocked) {
            publishResolved(pending, "timeout", "等待超时（" + APPROVAL_TIMEOUT.toSeconds() + "s），已自动放行");
            log.info("闸门 {} 等待超时，自动放行工具 {}", pending.gateId, tool);
            return new GateDecision(true, pending.args, "审批超时自动放行", true, java.util.Set.of());
        }
        GateDecision decision = pending.decision;
        if (decision == null) {
            return new GateDecision(false, pending.args, "审批结果丢失", false, java.util.Set.of());
        }
        return decision;
    }

    /**
     * 人工审批：放行（可带改过的参数）或拒绝。
     *
     * <p>参数合并规则见类注释第 3 条：只在原参数已有键上覆盖，且一律转成字符串。
     */
    public PendingView resolve(long sessionId, String gateId, boolean approved,
                               Map<String, Object> newArgs, String note) {
        Pending pending = gates.get(gateId);
        if (pending == null) {
            throw new com.webcode.assistant.common.ApiException(
                    com.webcode.assistant.common.ErrorCode.NOT_FOUND, "该闸门已失效或已被处理");
        }
        if (pending.sessionId != sessionId) {
            throw new com.webcode.assistant.common.ApiException(
                    com.webcode.assistant.common.ErrorCode.NOT_FOUND, "闸门不属于该会话");
        }

        MergedArgs merged = mergeArgs(pending.args, newArgs);
        pending.args = merged.args();
        pending.decision = approved
                ? new GateDecision(true, merged.args(), note, false, merged.changedKeys())
                : new GateDecision(false, merged.args(),
                        note == null || note.isBlank() ? "用户拒绝" : note, false, merged.changedKeys());
        pending.latch.countDown();

        publishResolved(pending, approved ? "approved" : "rejected",
                pending.decision.note() == null ? "" : pending.decision.note());
        log.info("闸门 {} 被人工{}（session={}）", gateId, approved ? "放行" : "拒绝", sessionId);
        return PendingView.of(pending);
    }

    /** 当前会话里等待中的闸门（前端刷新页面后用它恢复卡片）。 */
    public List<PendingView> pendingOf(long sessionId) {
        List<PendingView> views = new ArrayList<>();
        for (Pending pending : gates.values()) {
            if (pending.sessionId == sessionId) {
                views.add(PendingView.of(pending));
            }
        }
        return views;
    }

    public void forget(long sessionId) {
        gates.values().removeIf(pending -> {
            if (pending.sessionId == sessionId) {
                pending.decision = new GateDecision(false, pending.args, "会话已关闭", false, java.util.Set.of());
                pending.latch.countDown();
                return true;
            }
            return false;
        });
        policies.remove(sessionId);
    }

    private static MergedArgs mergeArgs(Map<String, Object> original, Map<String, Object> patch) {
        Map<String, Object> merged = new LinkedHashMap<>(original == null ? Map.of() : original);
        java.util.Set<String> changed = new java.util.LinkedHashSet<>();
        if (patch != null) {
            for (Map.Entry<String, Object> entry : patch.entrySet()) {
                if (!merged.containsKey(entry.getKey()) || entry.getValue() == null) {
                    continue;
                }
                String value = String.valueOf(entry.getValue());
                Object existing = merged.get(entry.getKey());
                if (existing != null && !value.equals(String.valueOf(existing))) {
                    changed.add(entry.getKey());
                    merged.put(entry.getKey(), value);
                }
            }
        }
        return new MergedArgs(merged, changed);
    }

    /** 参数合并结果：合并后的参数 + 哪些键是人工改过的。 */
    private record MergedArgs(Map<String, Object> args, java.util.Set<String> changedKeys) {
    }

    private void publishGate(Pending pending) {
        try {
            hub.publisher(pending.sessionId).toolGate(pending.gateId, pending.tool,
                    intentOf(pending.tool, pending.args), pending.args, true, pending.reason,
                    pending.expiresAt.toEpochMilli());
        } catch (RuntimeException ex) {
            log.debug("推送闸门事件失败: {}", ex.getMessage());
        }
    }

    private void publishResolved(Pending pending, String decision, String note) {
        try {
            hub.publisher(pending.sessionId).gateResolved(pending.gateId, decision, note);
        } catch (RuntimeException ex) {
            log.debug("推送闸门解除事件失败: {}", ex.getMessage());
        }
    }

    /** 「它想干什么」——闸门卡片上最上面那行字，必须是能让人一眼判断要不要放行的话。 */
    static String intentOf(String tool, Map<String, Object> args) {
        String path = args == null ? null : String.valueOf(args.getOrDefault("path", ""));
        String file = args == null ? null : String.valueOf(args.getOrDefault("file", ""));
        String pattern = args == null ? null : String.valueOf(args.getOrDefault("pattern", ""));
        return switch (tool) {
            case "propose_patch" -> "想在 " + blankTo(file, "某个文件") + " 上生成一个代码补丁（你确认后才写盘）";
            case "run_tests" -> "想在当前工作区里执行构建 / 测试命令（会真实跑进程，可能下载依赖）";
            case "grep" -> "想在整个工作区里检索 /" + blankTo(pattern, "…") + "/";
            case "semantic_search" -> "想调用 embedding 模型做一次语义检索";
            default -> "想执行 " + tool;
        };
    }

    private static String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    /** 等待中的闸门对外视图。 */
    public record PendingView(String gateId, long sessionId, String tool, String intent, String reason,
                              Map<String, Object> args, String createdAt, long expiresAt) {

        static PendingView of(Pending pending) {
            return new PendingView(pending.gateId, pending.sessionId, pending.tool,
                    intentOf(pending.tool, pending.args), pending.reason, pending.args,
                    pending.createdAt.toString(), pending.expiresAt.toEpochMilli());
        }
    }

    /** 一个等待中的闸门。{@code decision} 由审批线程写入、等待线程读取，靠 latch 建立 happens-before。 */
    private static final class Pending {

        private final String gateId;
        private final long sessionId;
        private final long workspaceId;
        private final String tool;
        private final String reason;
        private final Instant createdAt;
        private final Instant expiresAt;
        private final CountDownLatch latch = new CountDownLatch(1);

        private volatile Map<String, Object> args;
        private volatile GateDecision decision;

        private Pending(String gateId, long sessionId, long workspaceId, String tool,
                        Map<String, Object> args, String reason, Instant createdAt, Instant expiresAt) {
            this.gateId = gateId;
            this.sessionId = sessionId;
            this.workspaceId = workspaceId;
            this.tool = tool;
            this.args = args;
            this.reason = reason;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
        }
    }
}
