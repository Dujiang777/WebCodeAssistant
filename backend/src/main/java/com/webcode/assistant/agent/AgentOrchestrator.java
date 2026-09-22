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
import com.webcode.assistant.map.SpringMapService;
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
        this.executors = executors;
        this.objectMapper = objectMapper;
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

        // 先把用户消息落库，保证「已发送」的消息立刻可见（刷新页面也不会丢）
        long userMessageId = messageRepository.insert(request.sessionId(),
                ChatMessageRecord.ROLE_USER, request.content(), userMessageMeta(request));
        sessionRepository.touch(request.sessionId());

        ChatEventPublisher publisher = eventHub.publisher(request.sessionId());
        executors.agent().submit(() -> run(request, workspace, publisher));
        return userMessageId;
    }

    private void run(AgentRequest request, Workspace workspace, ChatEventPublisher publisher) {
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
                    appProperties, request.sessionId(), llmProperties.maxToolSteps());

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
                        assistantMessageId[0] = finish(request, workspace, answer, response, toolbox, publisher);
                    })
                    .onError(error -> {
                        log.warn("Agent 回合失败 session={}", request.sessionId(), error);
                        String message = describe(error);
                        persistAssistantError(request.sessionId(), message);
                        publisher.error(message);
                    })
                    .start();
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

    /** 回合结束：落库回答、挂上补丁、校验引用、记录用量、推送 done。 */
    private long finish(AgentRequest request, Workspace workspace, StringBuilder answer,
                        ChatResponse response, AgentToolbox toolbox, ChatEventPublisher publisher) {
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
