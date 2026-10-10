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
import com.webcode.assistant.llm.ResolvedModel;
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
import dev.langchain4j.model.output.TokenUsage;
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
import java.util.concurrent.atomic.AtomicBoolean;

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
    private final TurnCancellation cancellation;

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
                             ObjectMapper objectMapper,
                             TurnCancellation cancellation) {
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
        this.cancellation = cancellation;
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
        private final ResolvedModel model;
        private boolean settled;
        private boolean handedOff;

        Charge(String refId, long held, ResolvedModel model) {
            this.refId = refId;
            this.held = held;
            this.model = model;
        }

        String refId() {
            return refId;
        }

        long held() {
            return held;
        }

        /** 本轮用的模型。结算要按它的单价算，所以必须跟着 Charge 一起走到回调线程。 */
        ResolvedModel model() {
            return model;
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

        // 先解析本轮用哪个模型：单价与「是否计费」都由它决定，余额闸门与预扣都依赖它。
        // 放在最前面还有一个好处 —— 没有任何可用模型时，用户消息根本不会落库。
        ResolvedModel model = modelGateway.resolve(request.userId(), request.modelKey());

        // 两道闸门都在写库之前：邮箱未验证 / 积分不足时，不该在会话里留下一条
        // 「永远等不到回答」的用户消息。宁可让客户端拿一个明确的错误码。
        requireVerifiedEmail(request.userId());
        creditService.requireAffordable(request.userId(), model);

        // 先作废上一轮：新问题一来，旧循环在下一个工具边界停，SSE 也静音。
        // 必须在写本轮用户消息之前，这样历史里不会出现两条连着的用户消息没人收尾。
        long generation = cancellation.begin(request.sessionId());
        closeOrphanUserTurn(request.sessionId());

        // 先把用户消息落库，保证「已发送」的消息立刻可见（刷新页面也不会丢）
        long userMessageId = messageRepository.insert(request.sessionId(),
                ChatMessageRecord.ROLE_USER, request.content(), userMessageMeta(request, model));
        sessionRepository.touch(request.sessionId());

        // 预扣：refId 用刚生成的用户消息 id —— 它天然唯一，结算与退款都靠它对账。
        String refId = "msg:" + userMessageId;
        long held;
        try {
            held = creditService.hold(request.userId(), refId, model);
        } catch (ApiException ex) {
            // 并发下余额被另一轮抢光：把这条消息补一句失败说明，避免它悬在那里没人管
            persistAssistantError(request.sessionId(), ex.getMessage());
            throw ex;
        }
        Charge charge = new Charge(refId, held, model);

        ChatEventPublisher publisher = eventHub.publisher(request.sessionId())
                .boundTo(cancellation, generation);
        publisher.stage("已接到问题，正在排队启动…");
        executors.agent().submit(() -> {
            try {
                run(request, workspace, publisher, charge, generation);
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

    private void run(AgentRequest request, Workspace workspace, ChatEventPublisher publisher,
                     Charge charge, long generation) {
        try {
            usageGuard.checkRequestAllowed(request.userId());
        } catch (ApiException ex) {
            publisher.error(ex.getMessage());
            return;
        }

        // 走到这里一定已经解析出模型了（start 里 resolve 失败会直接抛给调用方，
        // 不会走到这个虚拟线程）。所以不再有「模型未配置」这一分支 ——
        // 那个判断在 V6 之前是必要的，现在它会让用户拿不到真正的错误原因。
        ResolvedModel model = charge.model();

        StringBuilder answer = new StringBuilder();
        long[] assistantMessageId = {-1L};

        try {
            publisher.stage("正在组装上下文…");
            String systemPrompt = contextAssembler.buildSystemPrompt(workspace, request);
            MessageWindowChatMemory memory = buildMemory(request, systemPrompt);

            AgentToolbox toolbox = new AgentToolbox(
                    workspace, publisher, fileService, grepService, patchService,
                    blastRadiusService, buildService, springMapService, semanticService,
                    appProperties, deskService, gateService, request.sessionId(), llmProperties.maxToolSteps(),
                    cancellation, generation);

            boolean direct = request.directAnswer();
            var builder = AiServices.builder(Assistant.class)
                    .streamingChatModel(modelGateway.require(model))
                    .chatMemory(memory);
            if (!direct) {
                // 不用 .tools(toolbox)：框架自动生成的执行器对「参数 JSON 解析失败」
                // 没有兜底（解析在 try 之外），坏 JSON 会穿透到 SSE 关闭回调被静默
                // 吞掉，前端永远「正在思考」。SafeToolExecutors 把它降级为喂回模型的
                // 工具失败结果，回合可自行恢复。见 SafeToolExecutors 类注释。
                builder = builder.tools(SafeToolExecutors.of(toolbox));
            }
            Assistant assistant = builder.build();

            publisher.stage(direct
                    ? "代码已在上下文，正在直接作答…"
                    : "已接到问题，正在调用模型…");
            AtomicBoolean streamEnded = new AtomicBoolean(false);
            AtomicBoolean firstByte = new AtomicBoolean(false);
            TokenStream stream = assistant.chat(request.content());
            stream.onPartialResponse(delta -> {
                        firstByte.set(true);
                        answer.append(delta);
                        publisher.text(delta);
                    })
                    .onCompleteResponse(response -> {
                        streamEnded.set(true);
                        // 收尾自身抛出的异常会被 langchain4j 的 ignoringExceptions 静默
                        // 吞掉（不进 onError），前端会永远「正在思考」。必须自己兜住：
                        // 至少让用户看到错误、把预扣退掉，而不是无声挂死。
                        try {
                            assistantMessageId[0] = finish(request, workspace, answer, response, toolbox,
                                    publisher, charge, generation);
                        } catch (RuntimeException ex) {
                            log.error("回合收尾异常 session={}", request.sessionId(), ex);
                            persistAssistantError(request.sessionId(), describe(ex));
                            publisher.error("回合收尾失败，本轮已退还预扣积分：" + describe(ex));
                            refundFailedTurn(request, charge);
                        }
                    })
                    .onError(error -> {
                        streamEnded.set(true);
                        log.warn("Agent 回合失败 session={}", request.sessionId(), error);
                        if (cancellation.isCanceled(request.sessionId(), generation)) {
                            if (cancellation.isStale(request.sessionId(), generation)) {
                                refundSuperseded(request, charge);
                                return;
                            }
                            // 用户停止：半截回答也要保留（不是失败），预扣全额退还
                            finishStopped(request, answer, toolbox, publisher, charge);
                            return;
                        }
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
            Thread.startVirtualThread(() ->
                    watchFirstByte(request.sessionId(), publisher, firstByte, streamEnded, generation));
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
        // 上一轮没来得及落 assistant 时，历史里会只剩一条用户要求。
        // 不标明「不要继续做」，模型会把斐波那契和「解释选区」当成同一轮任务。
        for (int i = 0; i < history.size(); i++) {
            if (!(history.get(i) instanceof UserMessage prior)) {
                continue;
            }
            boolean followedByAssistant = i + 1 < history.size() && history.get(i + 1) instanceof AiMessage;
            if (!followedByAssistant) {
                history.set(i, UserMessage.from(
                        "【系统注：这是更早的一条未完成请求，不要执行它，除非当前问题明确说「继续上一轮」。】\n"
                                + prior.singleText()));
            }
        }
        history.forEach(memory::add);
        return memory;
    }

    /**
     * 首字看门狗：模型排队时持续推 stage，避免前端只能空转。
     * 不在这里强杀回合 —— 工具先行时可能 60s 内都没有 text。
     */
    private void watchFirstByte(long sessionId, ChatEventPublisher publisher,
                                AtomicBoolean firstByte, AtomicBoolean streamEnded, long generation) {
        try {
            for (int tick = 1; tick <= 15; tick++) {
                Thread.sleep(8_000);
                if (streamEnded.get() || firstByte.get() || cancellation.isCanceled(sessionId, generation)) {
                    return;
                }
                int seconds = tick * 8;
                if (tick <= 3) {
                    publisher.stage("模型还在计算（已 " + seconds + " 秒），首字还没到…");
                } else {
                    publisher.stage("仍在等待模型首字（已 " + seconds + " 秒）。可点停止后换更快的模型。");
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** 回合结束：结算积分、落库回答、挂上补丁、校验引用、记录用量、推送 done。 */
    private long finish(AgentRequest request, Workspace workspace, StringBuilder answer,
                        ChatResponse response, AgentToolbox toolbox, ChatEventPublisher publisher,
                        Charge charge, long generation) {
        // 取消竞态兜底：工具抛出的 TurnCanceledException 会被 LangChain4j 当作
        // 「工具失败结果」喂回模型，回合反而自然完成走进这里 —— 那就不能按正常结算收尾
        //（用户点了停止却还被扣分、消息还没有 stopped 标记）。只要标志在，一律按停止处理。
        if (cancellation.isCanceled(request.sessionId(), generation)) {
            if (cancellation.isStale(request.sessionId(), generation)) {
                refundSuperseded(request, charge);
                return -1L;
            }
            finishStopped(request, answer, toolbox, publisher, charge);
            return -1L;
        }

        String text = answer.length() > 0
                ? answer.toString()
                : (response.aiMessage() == null ? "" : response.aiMessage().text());
        if (text == null) {
            text = "";
        }

        // 引用校验：只标注、不篡改正文。指向不存在文件的引用会被前端标红。
        List<Citation> citations = citationVerifier.verify(workspace, text);
        long invalidCitations = citations.stream().filter(citation -> !citation.valid()).count();

        ResolvedModel model = charge.model();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("model", model.modelKey());
        meta.put("modelName", model.displayName());
        meta.put("modelProvider", model.providerName());
        // 免积分模型要让前端知道「这轮不花钱」，否则它会显示一个没有意义的 −0 分
        meta.put("billable", model.billable());
        meta.put("mode", request.normalizedMode());
        if (response.tokenUsage() != null) {
            meta.put("inputTokens", response.tokenUsage().inputTokenCount());
            meta.put("outputTokens", response.tokenUsage().outputTokenCount());
            meta.put("totalTokens", response.tokenUsage().totalTokenCount());
        }

        // 结算必须发生在落库之前：这样「本轮花了多少积分、还剩多少」能直接写进消息 meta，
        // 前端不用为每个气泡再发一次请求。
        long charged = settle(request.userId(), charge, tokenOf(response, true), tokenOf(response, false));
        meta.put("credits", charged);
        meta.put("creditsBalance", creditService.summary(request.userId(), model).balance());

        meta.put("patches", toolbox.proposedPatches().stream().map(UUID::toString).toList());
        meta.put("citations", citations);
        meta.put("citationIssues", invalidCitations);
        // 计划流：模型给过计划就随 meta 落库，刷新后消息上仍能看到
        if (!toolbox.planSteps().isEmpty()) {
            meta.put("plan", toolbox.planSteps());
        }

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
            return creditService.settle(userId, charge.refId(), charge.held(), charge.model(),
                    inputTokens, outputTokens);
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
    /** 被新问题取代：退预扣、不落库、不推 done（新回合已经占用 SSE）。 */
    private void refundSuperseded(AgentRequest request, Charge charge) {
        if (charge.settled()) {
            return;
        }
        charge.settleDone();
        try {
            creditService.release(request.userId(), charge.refId(), charge.held(),
                    "被新问题打断，退还预扣");
        } catch (RuntimeException refundFailure) {
            log.error("被取代后退款失败 userId={} refId={}", request.userId(), charge.refId(), refundFailure);
        }
        log.info("回合被新问题取代 session={} refId={}", request.sessionId(), charge.refId());
    }

    /**
     * 上一轮还没写出 assistant 时，补一条停止说明，避免历史变成「两条用户消息连在一起」。
     * 必须在插入本轮用户消息之前调用。
     */
    private void closeOrphanUserTurn(long sessionId) {
        List<ChatMessageRecord> recent = messageRepository.findRecent(sessionId, 1);
        if (recent.isEmpty()) {
            return;
        }
        ChatMessageRecord last = recent.getLast();
        if (!ChatMessageRecord.ROLE_USER.equals(last.role())) {
            return;
        }
        try {
            messageRepository.insert(sessionId, ChatMessageRecord.ROLE_ASSISTANT,
                    "⏹ 你提了新问题，上一轮已停止。",
                    toJson(Map.of("stopped", true, "superseded", true)));
            sessionRepository.touch(sessionId);
        } catch (RuntimeException ex) {
            log.warn("补写上一轮停止说明失败 session={}", sessionId, ex);
        }
    }

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

    /**
     * 用户停止本轮的收尾：与失败不同，<b>这不是错误</b>。
     *
     * <p>已经流出到前端的半截回答要落库保留（前端刷新后依然可见），
     * 已生成的补丁照常挂到这条消息上，预扣全额退还（模型侧 token 是否已消耗
     * 不由用户买单 —— 停止是产品行为，不是事故）。事件顺序：
     * {@code canceled}（前端立刻把运行中的工具卡标停）→ {@code done}（收尾渲染）。
     *
     * <p> {@code settleDone()} 必须先于 release：这一位是「本轮终局已定」的标记，
     * 漏了它外层兜底/重复回调会再退一遍。
     */
    private void finishStopped(AgentRequest request, StringBuilder answer, AgentToolbox toolbox,
                               ChatEventPublisher publisher, Charge charge) {
        charge.settleDone();
        try {
            creditService.release(request.userId(), charge.refId(), charge.held(),
                    "用户停止本轮，退还预扣");
        } catch (RuntimeException refundFailure) {
            log.error("停止退款失败 userId={} refId={}", request.userId(), charge.refId(), refundFailure);
        }

        String text = answer.length() > 0
                ? answer.toString()
                : "⏹ 已按你的要求停止本轮。已执行的工具步骤到此为止，没有产出结论。";
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("stopped", true);
        meta.put("model", charge.model().modelKey());
        meta.put("modelName", charge.model().displayName());
        meta.put("billable", charge.model().billable());
        meta.put("mode", request.normalizedMode());
        meta.put("credits", 0);
        if (!toolbox.planSteps().isEmpty()) {
            meta.put("plan", toolbox.planSteps());
        }
        long messageId = messageRepository.insert(request.sessionId(),
                ChatMessageRecord.ROLE_ASSISTANT, text, toJson(meta));
        sessionRepository.touch(request.sessionId());

        // 半轮里可能已经产出补丁：照常挂消息，用户仍可审阅应用
        for (UUID patchId : toolbox.proposedPatches()) {
            patchService.attachMessage(patchId, messageId);
        }

        publisher.canceled();
        publisher.done(messageId);
    }

    private static long tokenOf(ChatResponse response, boolean input) {
        if (response == null) {
            return 0;
        }
        TokenUsage usage;
        try {
            usage = response.tokenUsage();
        } catch (ClassCastException ex) {
            // langchain4j 1.0.0 缺陷：多步回合的终响应会把跨步累计的 usage 塞回
            // OpenAiChatResponseMetadata，而它的 getter 强转 OpenAiTokenUsage；
            // 终轮缺 usage chunk 时 add(null) 返回基类实例 → 一读就 CCE。
            // 降级为 0：回合照常结算收尾，不能因为计量问题把整个回合炸掉。
            return 0;
        }
        if (usage == null) {
            return 0;
        }
        Integer value = input
                ? usage.inputTokenCount()
                : usage.outputTokenCount();
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

    private String userMessageMeta(AgentRequest request, ResolvedModel model) {
        Map<String, Object> meta = new LinkedHashMap<>();
        // 把本轮用哪个模型记在用户消息上：刷新页面后，气泡旁的「−N 分」要能
        // 说清是哪次调用花的，而不用去翻 assistant 消息。
        meta.put("model", model.modelKey());
        meta.put("modelName", model.displayName());
        meta.put("billable", model.billable());
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
