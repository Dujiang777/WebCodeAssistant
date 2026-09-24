package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.build.BuildService;
import com.webcode.assistant.context.Citation;
import com.webcode.assistant.context.CitationVerifier;
import com.webcode.assistant.context.ContextAssembler;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.config.ExecutorConfig;
import com.webcode.assistant.llm.ChatModelConfig;
import com.webcode.assistant.llm.LlmProperties;
import com.webcode.assistant.llm.UsageGuard;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.UserAccount;
import com.webcode.assistant.map.SpringMapService;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspaceService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.TokenStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Agent 编排：一次对话从「收到消息」到「推送 done」的全过程。
 *
 * <p>执行链条（每一步都可独立观测）：
 * <pre>
 *   POST /messages
 *        └─ 立即入库用户消息，返回 messageId          ← HTTP 在这里就返回了
 *        └─ 提交到虚拟线程 ↓
 *             ├─ 限流 / 配额检查
 *             ├─ 组装 system prompt（项目画像 + 规则文件 + 当前文件 + 选区）
 *             ├─ 从数据库取最近 N 条历史，预置进 ChatMemory
 *             ├─ 构建 AiService（绑定本轮的 AgentToolbox）
 *             ├─ TokenStream.start()
 *             │     ├─ onPartialResponse → SSE text
 *             │     ├─ 工具执行（工具内部自推 tool_call / tool_result / patch）
 *             │     └─ onCompleteResponse → 落库 assistant 消息 + SSE done
 *             └─ onError → 落库失败说明 + SSE error
 * </pre>
 *
 * <p>关键点：<b>模型进程内拿不到任何写盘能力</b>。唯一能产出改动的工具是 {@code propose_patch}，
 * 它只写 patches 表并推一条 {@code patch} 事件，真正的文件写入要等用户调 {@code apply}。
 */
@Service
public class AgentOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AgentOrchestrator.class);

    private final ChatModelConfig.ModelGateway modelGateway;
    private final ChatEventHub eventHub;
    private final ChatMessageRepository messageRepository;
    private final ChatSessionRepository sessionRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceFileService fileService;
    private final GrepService grepService;
    private final PatchService patchService;
    private final BlastRadiusService blastRadiusService;
    private final BuildService buildService;
    private final SpringMapService springMapService;
    private final com.webcode.assistant.semantic.SemanticIndexService semanticService;
    private final ContextAssembler contextAssembler;
    private final CitationVerifier citationVerifier;
    private final UsageGuard usageGuard;
    private final LlmProperties llmProperties;
    private final AppProperties appProperties;
    private final AgentDeskService deskService;
    private final ToolGateService gateService;
    private final CreditService creditService;
    private final AuthService authService;
    private final ExecutorConfig.AppExecutors executors;
    private final ObjectMapper objectMapper;

    public AgentOrchestrator(ChatModelConfig.ModelGateway modelGateway,
                             ChatEventHub eventHub,
                             ChatMessageRepository messageRepository,
                             ChatSessionRepository sessionRepository,
                             WorkspaceService workspaceService,
                             WorkspaceFileService fileService,
                             GrepService grepService,
                             PatchService patchService,
                             BlastRadiusService blastRadiusService,
                             BuildService buildService,
                             SpringMapService springMapService,
                             com.webcode.assistant.semantic.SemanticIndexService semanticService,
                             ContextAssembler contextAssembler,
                             CitationVerifier citationVerifier,
                             UsageGuard usageGuard,
                             LlmProperties llmProperties,
                             AppProperties appProperties,
                             AgentDeskService deskService,
                             ToolGateService gateService,
                             CreditService creditService,
                             AuthService authService,
                             ExecutorConfig.AppExecutors executors,
                             ObjectMapper objectMapper) {
        this.modelGateway = modelGateway;
        this.eventHub = eventHub;
        this.messageRepository = messageRepository;
        this.sessionRepository = sessionRepository;
        this.workspaceService = workspaceService;
        this.fileService = fileService;
        this.grepService = grepService;
        this.patchService = patchService;
        this.blastRadiusService = blastRadiusService;
        this.buildService = buildService;
        this.springMapService = springMapService;
        this.semanticService = semanticService;
        this.contextAssembler = contextAssembler;
        this.citationVerifier = citationVerifier;
        this.usageGuard = usageGuard;
        this.llmProperties = llmProperties;
        this.appProperties = appProperties;
        this.deskService = deskService;
        this.gateService = gateService;
        this.creditService = creditService;
        this.authService = authService;
        this.executors = executors;
        this.objectMapper = objectMapper;
    }

    /**
     * 本轮的计费凭据。
     *
     * <p>为什么需要一个小对象而不是两个局部变量：预扣发生在 {@link #start}（HTTP 线程），
     * 结算发生在 {@link #finish}（流式回调线程），而「失败了要全额退回预扣」这件事
     * 必须由一个地方统一兜底 —— 就是 {@link #run} 外面的 finally。
     * 三处都要知道「这轮到底预扣了多少、结没结算过」，用可变状态表达最直接。
     *
     * <p>两个标志位各管一件事，缺一个都会退错钱：
     * <ul>
     *   <li>{@code settled}：结算已发生，兜底退回不能再执行
     *       （否则「先扣 30、结算退 12、兜底再退 30」会退重）；</li>
     *   <li>{@code handedOff}：回合已经交给事件流，生命周期归
     *       {@code onCompleteResponse} / {@code onError}。
     *       <b>这一位是必须的</b>：LangChain4j 的 {@code stream.start()} 是<b>异步</b>的，
     *       {@link #run} 会在模型刚开始生成时就返回，外层 finally 若照旧退款，
     *       就会在用户还在等回答的时候把预扣退回去 —— 预扣彻底失效，
     *       余额闸门也就成了摆设。</li>
     * </ul>
     */
    private static final class Charge {
        private final String refId;
        private final long held;
        private boolean settled;
        private boolean handedOff;

        Charge(String refId, long held) {
            this.refId = refId;
            this.held = held;
        }

        String refId() {
            return refId;
        }

        long held() {
            return held;
        }

        void settleDone() {
            this.settled = true;
        }

        boolean settled() {
            return settled;
        }

        void handOff() {
            this.handedOff = true;
        }

        boolean handedOff() {
            return handedOff;
        }
    }

    /**
     * 立即返回用户消息 id，并把 Agent 任务交给虚拟线程。
     *
     * @return 刚落库的用户消息 id
     */
    public long start(AgentRequest request) {
        ChatSession session = sessionRepository.findOwned(request.sessionId(), request.userId())
                .orElseThrow(() -> new ApiException(com.webcode.assistant.common.ErrorCode.NOT_FOUND,
                        "会话不存在或无权访问"));
        Workspace workspace = workspaceService.require(request.userId(), session.workspaceId());
        if (workspace.id() != request.workspaceId()) {
            throw new ApiException(com.webcode.assistant.common.ErrorCode.BAD_REQUEST,
                    "workspaceId 与所属会话不一致");
        }

        // 两道闸门都在写库之前：邮箱未验证 / 积分不足时，不该在会话里留下一条
        // 「永远等不到回答」的用户消息。宁可让客户端拿一个明确的错误码。
        requireVerifiedEmail(request.userId());
        creditService.requireAffordable(request.userId());

        // 先把用户消息落库，保证「已发送」的消息立刻可见（刷新页面也不会丢）
        long userMessageId = messageRepository.insert(request.sessionId(),
                ChatMessageRecord.ROLE_USER, request.content(), userMessageMeta(request));
        sessionRepository.touch(request.sessionId());

        // 预扣：refId 用刚生成的用户消息 id —— 它天然唯一，结算与退款都靠它对账。
        String refId = "msg:" + userMessageId;
        long held;
        try {
            held = creditService.hold(request.userId(), refId);
        } catch (ApiException ex) {
            // 并发下余额被另一轮抢光：把这条消息补一句失败说明，避免它悬在那里没人管
            persistAssistantError(request.sessionId(), ex.getMessage());
            throw ex;
        }
        Charge charge = new Charge(refId, held);

        ChatEventPublisher publisher = eventHub.publisher(request.sessionId());
        executors.agent().submit(() -> {
            try {
                run(request, workspace, publisher, charge);
            } finally {
                // 兜底退款只覆盖「回合根本没跑起来」的路径（被限额拦下、模型未配置、装配异常）。
                // 一旦事件流接手（handedOff），退款就只能由结算或 onError 负责 ——
                // 见 Charge 上关于 handedOff 的说明，这里踩过一次真坑。
                if (!charge.handedOff() && !charge.settled()) {
                    try {
                        creditService.release(request.userId(), charge.refId(), charge.held(),
                                "本轮未启动，退还预扣");
                    } catch (RuntimeException refundFailure) {
                        log.error("退还预扣失败 userId={} refId={}", request.userId(), charge.refId(),
                                refundFailure);
                    }
                }
            }
        });
        return userMessageId;
    }

    /**
     * 邮箱验证闸门（默认关闭，见 {@code AUTH_REQUIRE_VERIFIED_EMAIL}）。
     *
     * <p>默认关是有意的：存量账号与演示账号都没有邮箱，一上来就硬拦会把老用户锁在门外。
     * 开启后只挡「调用模型」这一件事 —— 文件浏览、编辑、快照全都照常，
     * 因为「不让用 AI」和「不让用产品」是两回事。
     */
    private void requireVerifiedEmail(long userId) {
        if (!appProperties.auth().requireVerifiedEmail()) {
            return;
        }
        UserAccount account = authService.require(userId);
        if (!account.emailVerified()) {
            throw new ApiException(ErrorCode.EMAIL_NOT_VERIFIED,
                    "邮箱尚未验证，请先在「账号」里完成邮箱验证再使用 AI 功能");
        }
    }

    private void run(AgentRequest request, Workspace workspace, ChatEventPublisher publisher, Charge charge) {
        try {
            usageGuard.checkRequestAllowed(request.userId());
        } catch (ApiException ex) {
            publisher.error(ex.getMessage());
            return;
        }

        if (!modelGateway.configured()) {
            String message = "后端未配置模型服务（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。"
                    + "文件浏览与编辑仍可正常使用，配置模型后即可开始对话。";
            persistAssistantError(request.sessionId(), message);
            publisher.error(message);
            return;
        }

        StringBuilder answer = new StringBuilder();
        long[] assistantMessageId = {-1L};

        try {
            String systemPrompt = contextAssembler.buildSystemPrompt(workspace, request);
            MessageWindowChatMemory memory = buildMemory(request, systemPrompt);

            AgentToolbox toolbox = new AgentToolbox(
                    workspace, publisher, fileService, grepService, patchService,
                    blastRadiusService, buildService, springMapService, semanticService,
                    appProperties, deskService, gateService, request.sessionId(), llmProperties.maxToolSteps());

            Assistant assistant = AiServices.builder(Assistant.class)
                    .streamingChatModel(modelGateway.require())
                    .tools(toolbox)
                    .chatMemory(memory)
                    .build();

            TokenStream stream = assistant.chat(request.content());
            stream.onPartialResponse(delta -> {
                        answer.append(delta);
                        publisher.text(delta);
                    })
                    .onCompleteResponse(response -> {
                        assistantMessageId[0] = finish(request, workspace, answer, response, toolbox,
                                publisher, charge);
                    })
                    .onError(error -> {
                        log.warn("Agent 回合失败 session={}", request.sessionId(), error);
                        String message = describe(error);
                        persistAssistantError(request.sessionId(), message);
                        publisher.error(message);
                        // 回合失败 = 没花掉 token = 必须退钱。事件流接手之后，退款责任在这里，
                        // 不在外层的兜底（那时候模型可能还在生成，见 Charge.handedOff）。
                        refundFailedTurn(request, charge);
                    })
                    .start();
            // start() 是异步的：从这里开始，本轮的收尾（结算或退款）归事件流回调负责
            charge.handOff();
        } catch (RuntimeException ex) {
            log.error("Agent 启动异常 session={}", request.sessionId(), ex);
            String message = describe(ex);
            persistAssistantError(request.sessionId(), message);
            publisher.error(message);
        }
    }

    /**
     * 组装 ChatMemory。
     *
     * <p>顺序很重要：<b>先放 system prompt，再放历史</b>。LangChain4j 的
     * {@code MessageWindowChatMemory} 会保护下标 0 上的 SystemMessage 不被淘汰，
     * 而 AiServices 在没有额外 system 消息时会直接在尾部追加本轮用户消息，
     * 因此最终顺序稳定为 {@code [System, 历史…, 本轮用户消息]}。
     *
     * <p>历史在写库<b>之前</b>取，避免本轮消息在历史里出现两次。
     */
    private MessageWindowChatMemory buildMemory(AgentRequest request, String systemPrompt) {
        int historyLimit = Math.max(0, llmProperties.historyMessages());
        MessageWindowChatMemory memory = MessageWindowChatMemory.withMaxMessages(historyLimit + 2);
        memory.add(SystemMessage.from(systemPrompt));

        // findRecent 会包含刚刚落库的本轮用户消息，跳过最后一条即可
        List<ChatMessageRecord> recent = messageRepository.findRecent(request.sessionId(), historyLimit + 1);
        List<ChatMessage> history = new ArrayList<>();
        for (ChatMessageRecord record : recent) {
            if (ChatMessageRecord.ROLE_USER.equals(record.role())) {
                history.add(UserMessage.from(record.content()));
            } else if (ChatMessageRecord.ROLE_ASSISTANT.equals(record.role())) {
                history.add(AiMessage.from(record.content()));
            }
        }
        // 去掉末尾的本轮用户消息（它会由 AiServices 以 userMessage 参数身份加入）
        if (!history.isEmpty() && history.getLast() instanceof UserMessage last
                && last.singleText().equals(request.content())) {
            history.removeLast();
        }
        while (history.size() > historyLimit) {
            history.removeFirst();
        }
        history.forEach(memory::add);
        return memory;
    }

    /** 回合结束：结算积分、落库回答、挂上补丁、校验引用、记录用量、推送 done。 */
    private long finish(AgentRequest request, Workspace workspace, StringBuilder answer,
                        ChatResponse response, AgentToolbox toolbox, ChatEventPublisher publisher,
                        Charge charge) {
        String text = answer.length() > 0
                ? answer.toString()
                : (response.aiMessage() == null ? "" : response.aiMessage().text());
        if (text == null) {
            text = "";
        }

        // 引用校验：只标注、不篡改正文。指向不存在文件的引用会被前端标红。
        List<Citation> citations = citationVerifier.verify(workspace, text);
        long invalidCitations = citations.stream().filter(citation -> !citation.valid()).count();

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("model", modelGateway.modelName());
        meta.put("mode", request.normalizedMode());
        if (response.tokenUsage() != null) {
            meta.put("inputTokens", response.tokenUsage().inputTokenCount());
            meta.put("outputTokens", response.tokenUsage().outputTokenCount());
            meta.put("totalTokens", response.tokenUsage().totalTokenCount());
        }

        // 结算必须发生在落库之前：这样「本轮花了多少积分、还剩多少」能直接写进消息 meta，
        // 前端不用为每个气泡再发一次请求。
        long charged = settle(request.userId(), charge,
                tokenOf(response, true), tokenOf(response, false));
        meta.put("credits", charged);
        meta.put("creditsBalance", creditService.summary(request.userId()).balance());

        meta.put("patches", toolbox.proposedPatches().stream().map(UUID::toString).toList());
        meta.put("citations", citations);
        meta.put("citationIssues", invalidCitations);

        long messageId = messageRepository.insert(request.sessionId(),
                ChatMessageRecord.ROLE_ASSISTANT, text, toJson(meta));
        sessionRepository.touch(request.sessionId());

        // 补丁在生成时还不知道 assistant 消息 id，这里回填关联
        for (UUID patchId : toolbox.proposedPatches()) {
            patchService.attachMessage(patchId, messageId);
        }

        try {
            if (response.tokenUsage() != null && response.tokenUsage().totalTokenCount() != null) {
                usageGuard.recordTokens(request.userId(), response.tokenUsage().totalTokenCount());
            }
        } catch (ApiException quotaExceeded) {
            // 本回合已经生成完毕，配额提示只作为一条错误事件告知，不抹掉已有结果
            publisher.error(quotaExceeded.getMessage());
        }

        publisher.citations(citations);
        publisher.done(messageId);
        return messageId;
    }

    /**
     * 结算积分：用真实用量取代预扣，多退少补。
     *
     * <p>{@code finally { charge.settleDone(); }} 是关键：<b>只要这一轮真的把答案生成出来了，
     * 就必须标记已结算</b>（哪怕结算本身失败了）。否则外层兜底或失败退款会再把预扣退一遍，
     * 变成「回答给你了，钱也没收」。
     */
    private long settle(long userId, Charge charge, long inputTokens, long outputTokens) {
        try {
            return creditService.settle(userId, charge.refId(), charge.held(), inputTokens, outputTokens);
        } catch (RuntimeException ex) {
            log.error("结算积分失败 userId={} refId={}", userId, charge.refId(), ex);
            return charge.held();
        } finally {
            charge.settleDone();
        }
    }

    /**
     * 回合失败时退还预扣。
     *
     * <p>先 {@code settleDone()} 再退：这一次调用本身就是本轮的终局，
     * 标记好之后外层兜底（以及可能的重复回调）都不会再退第二遍。
     * {@code CreditService.release} 内部还挂着 {@code RELEASE:{userId}:{refId}} 幂等键，
     * 是第二道保险。
     */
    private void refundFailedTurn(AgentRequest request, Charge charge) {
        if (charge.settled()) {
            return;
        }
        charge.settleDone();
        try {
            creditService.release(request.userId(), charge.refId(), charge.held(),
                    "本轮失败，退还预扣");
        } catch (RuntimeException refundFailure) {
            log.error("退还预扣失败 userId={} refId={}", request.userId(), charge.refId(), refundFailure);
        }
    }

    private static long tokenOf(ChatResponse response, boolean input) {
        if (response == null || response.tokenUsage() == null) {
            return 0;
        }
        Integer value = input
                ? response.tokenUsage().inputTokenCount()
                : response.tokenUsage().outputTokenCount();
        return value == null ? 0 : value;
    }

    private void persistAssistantError(long sessionId, String message) {
        try {
            messageRepository.insert(sessionId, ChatMessageRecord.ROLE_ASSISTANT,
                    "⚠️ 本轮生成失败：" + message,
                    toJson(Map.of("error", true, "message", message)));
            sessionRepository.touch(sessionId);
        } catch (RuntimeException ex) {
            log.warn("写入失败说明时出错 session={}", sessionId, ex);
        }
    }

    private String userMessageMeta(AgentRequest request) {
        Map<String, Object> meta = new LinkedHashMap<>();
        if (request.currentFile() != null && !request.currentFile().isBlank()) {
            meta.put("currentFile", request.currentFile());
        }
        if (request.selection() != null && !request.selection().isEmpty()) {
            Map<String, Object> selection = new LinkedHashMap<>();
            selection.put("startLine", request.selection().startLine());
            selection.put("endLine", request.selection().endLine());
            selection.put("text", request.selection().text());
            meta.put("selection", selection);
        }
        return toJson(meta);
    }

    private String toJson(Map<String, Object> value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            log.debug("序列化 meta 失败: {}", ex.getMessage());
            return "{}";
        }
    }

    /** 把底层异常翻译成用户能看懂的一句话，不把堆栈丢给前端。 */
    private String describe(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        String message = cause.getMessage();
        if (message == null || message.isBlank()) {
            message = cause.getClass().getSimpleName();
        }
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("401") || lower.contains("unauthorized") || lower.contains("invalid api key")) {
            return "模型服务拒绝了请求（401）。请检查 LLM_API_KEY 是否正确、是否与 LLM_BASE_URL 匹配。";
        }
        if (lower.contains("404") || lower.contains("model not found")) {
            return "模型不存在（404）。请检查 LLM_MODEL 是否为该服务商支持的模型名。";
        }
        if (lower.contains("429") || lower.contains("rate limit")) {
            return "模型服务限流（429），请稍后再试。";
        }
        if (lower.contains("timeout") || lower.contains("timed out")) {
            return "调用模型超时。可以在环境变量里调大 LLM_TIMEOUT，或换一个更快的模型。";
        }
        if (lower.contains("connect") || lower.contains("unknown host") || lower.contains("refused")) {
            return "无法连接模型服务。请检查 LLM_BASE_URL 与网络连通性。";
        }
        return message.length() > 300 ? message.substring(0, 300) + "..." : message;
    }
}
