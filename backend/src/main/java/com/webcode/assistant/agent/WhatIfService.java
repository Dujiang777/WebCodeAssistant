package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.llm.ChatModelConfig;
import com.webcode.assistant.workspace.ShadowWorkspaceService;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspaceService;
import com.webcode.assistant.workspace.diff.FilePatch;
import com.webcode.assistant.workspace.diff.UnifiedDiffApplier;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import dev.langchain4j.service.AiServices;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 反事实分支 / What-if 宇宙 —— 功能 15。
 *
 * <p><b>产品主张：</b>设计讨论不该只是「口头方案」，而应该是一个能跑、能看、能对比的分身。
 * 用户问「假如这段不走 Service 直接发领域事件？」—— 我们在一次性影子工作区里把它改出来，
 * 和主线代码左右对照；<b>默认不合并</b>，想合并时它才变成一条普通的待确认补丁回到主线流程。
 *
 * <p><b>为什么落成「生成一条 diff」而不是「跑一个完整 Agent 回合」：</b>
 * 影子的价值在于<b>可丢弃</b>与<b>可对比</b>，不在于多跑几轮工具。生成一条 diff 就够形成判断，
 * 而且天然复用了主线的补丁校验（解析 → 干跑 → 只有干净应用才展示）。
 *
 * <p><b>降级策略：</b>模型不可用 / 返回的东西解析不出 diff 时，分支会以明确状态落成
 * {@code unavailable} 并带上原因 —— 而不是假装成功或者静默失败。这个项目里
 * 「不可用要说出来」比「看起来总是成功」重要。
 */
@Service
public class WhatIfService {

    private static final Logger log = LoggerFactory.getLogger(WhatIfService.class);

    private static final String STATUS_READY = "ready";
    private static final String STATUS_UNAVAILABLE = "unavailable";
    private static final String STATUS_ADOPTED = "adopted";
    private static final String STATUS_DISCARDED = "discarded";

    /** 终态分支（已丢弃 / 已采纳）每个工作区只留最近这么多条 —— 它们是「试过什么」的足迹，
     *  有参考价值但不该无限增长（每条都还握着左右两份文件正文）。 */
    private static final int MAX_TERMINAL_BRANCHES = 12;

    /** 影子是「一次实验」，问一句就该有结果；模型太久不返回就明确说失败。 */
    private static final long LLM_TIMEOUT_SECONDS = 120;

    private final ChatModelConfig.ModelGateway modelGateway;
    private final ShadowWorkspaceService shadowService;
    private final WorkspaceService workspaceService;
    private final WorkspaceFileService fileService;
    private final PatchService patchService;

    /** shadowId → 分支（内存态：影子本身就是临时的，重启后清空更符合直觉）。 */
    private final Map<String, Branch> branches = new ConcurrentHashMap<>();

    public WhatIfService(ChatModelConfig.ModelGateway modelGateway,
                         ShadowWorkspaceService shadowService,
                         WorkspaceService workspaceService,
                         WorkspaceFileService fileService,
                         PatchService patchService) {
        this.modelGateway = modelGateway;
        this.shadowService = shadowService;
        this.workspaceService = workspaceService;
        this.fileService = fileService;
        this.patchService = patchService;
    }

    /** 一次 What-if 实验的对外视图。 */
    public record BranchView(String id, long workspaceId, String question, String file, String status,
                             String note, String mainText, String shadowText, String diff,
                             int added, int removed, String createdAt) {

        static BranchView of(Branch branch) {
            return new BranchView(branch.id, branch.workspaceId, branch.question, branch.file, branch.status,
                    branch.note, branch.mainText, branch.shadowText, branch.diff,
                    branch.added, branch.removed, branch.createdAt.toString());
        }
    }

    /** 采纳结果：平行宇宙的改法变成主线上的一条待确认补丁。 */
    public record AdoptResult(String patchId, String file, String note) {
    }

    /**
     * 开一次 What-if：拷影子 → 让模型把设想写成 diff → 校验并落到影子文件 → 返回左右对照。
     *
     * @param file      要在哪个文件上做实验（必须是工作区里已存在的文本文件）
     * @param sessionId 采纳时补丁要挂到的会话（前端用的是当前会话）
     */
    public BranchView ask(long userId, long workspaceId, long sessionId, String question, String file) {
        if (question == null || question.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "请描述你的反事实设想，例如「假如用领域事件而不是直接调 Service？」");
        }
        String path = normalize(file);
        if (path.isEmpty()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "请先打开一个文件，What-if 需要明确的实验对象");
        }
        Workspace workspace = workspaceService.require(userId, workspaceId);
        String mainText = fileService.readFullText(workspace, path, 512 * 1024);

        ShadowWorkspaceService.Shadow shadow =
                shadowService.create(userId, workspace, workspaceService.rootOf(workspace));
        Path shadowRoot = shadowService.rootOf(userId, shadow.id());

        String prompt = buildPrompt(path, mainText, question);
        String raw = null;
        String note = null;
        String status = STATUS_READY;
        String diff = null;
        String shadowText = null;
        int added = 0;
        int removed = 0;

        try {
            raw = complete(prompt);
        } catch (ApiException ex) {
            status = STATUS_UNAVAILABLE;
            note = "模型不可用：" + ex.getMessage();
        } catch (RuntimeException ex) {
            status = STATUS_UNAVAILABLE;
            note = "模型调用失败：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
        }

        if (STATUS_READY.equals(status)) {
            String candidate = extractDiff(raw);
            if (candidate == null || candidate.isBlank()) {
                status = STATUS_UNAVAILABLE;
                note = "模型没有返回可用的 unified diff，无法构造平行宇宙";
            } else {
                try {
                    FilePatch filePatch = UnifiedDiffParser.parse(candidate, path).get(0);
                    shadowText = UnifiedDiffApplier.apply(mainText, filePatch);
                    added = filePatch.addedLines();
                    removed = filePatch.removedLines();
                    diff = candidate;
                    // 落到影子文件：影子是真实存在的目录，用户「丢弃」就是删掉它
                    shadowService.writeFile(shadowRoot, path, shadowText);
                } catch (ApiException ex) {
                    status = STATUS_UNAVAILABLE;
                    note = "模型给出的改动无法干净地应用到当前文件：" + ex.getMessage();
                } catch (RuntimeException ex) {
                    status = STATUS_UNAVAILABLE;
                    note = "模型给出的改动无法解析：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
                }
            }
        }

        if (!STATUS_READY.equals(status)) {
            // 失败也要把影子删掉：一个失败的实验不该占着磁盘
            shadowService.discard(shadowRoot);
        }

        Branch branch = new Branch(shadow.id(), userId, workspaceId, sessionId, question, path,
                shadowRoot.toString(), mainText, shadowText, diff, added, removed, status,
                note, Instant.now());
        branches.put(branch.id, branch);

        if (STATUS_READY.equals(status)) {
            log.info("What-if 分支 {} 就绪：{} （+{} / -{}）", branch.id, path, added, removed);
        } else {
            log.info("What-if 分支 {} 未就绪：{}", branch.id, note);
        }
        pruneTerminal(userId, workspaceId);
        return BranchView.of(branch);
    }

    /** 只裁「已经有结局」的分支，且按时间留最近的 —— 正在推演中的一条都不能动。 */
    private void pruneTerminal(long userId, long workspaceId) {
        List<Branch> terminal = new ArrayList<>();
        for (Branch branch : branches.values()) {
            if (branch.userId == userId && branch.workspaceId == workspaceId
                    && !STATUS_READY.equals(branch.status) && !STATUS_UNAVAILABLE.equals(branch.status)) {
                terminal.add(branch);
            }
        }
        if (terminal.size() <= MAX_TERMINAL_BRANCHES) {
            return;
        }
        terminal.sort(Comparator.comparing(Branch::createdAt));
        for (int i = 0; i < terminal.size() - MAX_TERMINAL_BRANCHES; i += 1) {
            branches.remove(terminal.get(i).id);
        }
    }

    public BranchView get(long userId, String id) {
        return BranchView.of(require(userId, id));
    }

    public List<BranchView> list(long userId, long workspaceId) {
        List<Branch> owned = new ArrayList<>();
        for (Branch branch : branches.values()) {
            if (branch.userId == userId && branch.workspaceId == workspaceId) {
                owned.add(branch);
            }
        }
        owned.sort(Comparator.comparing((Branch branch) -> branch.createdAt).reversed());
        return owned.stream().map(BranchView::of).toList();
    }

    /**
     * 丢弃：默认结局。删影子目录，但**保留记录**并标记为 discarded ——
     * 「试过哪些设想、结局如何」本身就是有价值的历史，抹掉它等于让这块面板永远空白。
     */
    public BranchView discard(long userId, String id) {
        Branch branch = require(userId, id);
        if (STATUS_READY.equals(branch.status())) {
            shadowService.discard(Path.of(branch.shadowRoot()));
        }
        String note = branch.note() == null || branch.note().isBlank()
                ? "已丢弃：影子工作区已删除，主线一个字节都没动"
                : branch.note() + "（已丢弃）";
        Branch updated = branch.withoutShadow().withStatus(STATUS_DISCARDED, note);
        branches.put(id, updated);
        log.info("What-if 分支 {} 已丢弃", id);
        return BranchView.of(updated);
    }

    /**
     * 采纳：把平行宇宙的改法转成主线上的一条<b>普通待确认补丁</b>。
     *
     * <p>注意这里不是直接写盘 —— 它只是把「平行宇宙」搬回主线流程的起点，
     * 后面照旧要走「快照 → 应用」那套人在环上的流程。反事实实验不该成为绕过审查的捷径。
     */
    public AdoptResult adopt(long userId, String id) {
        Branch branch = require(userId, id);
        if (!STATUS_READY.equals(branch.status)) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "这个分支没有可采纳的改动（" + branch.note + "）");
        }
        Workspace workspace = workspaceService.require(userId, branch.workspaceId);
        Patch patch = patchService.propose(branch.sessionId, null, workspace, branch.file, branch.diff);
        shadowService.discard(Path.of(branch.shadowRoot));
        // 保留记录：历史里要能看出「这个设想被采纳成了哪条补丁」
        Branch updated = branch.withoutShadow()
                .withStatus(STATUS_ADOPTED, "已采纳为主线待确认补丁 " + patch.id() + "，仍需审阅后才能应用");
        branches.put(id, updated);
        log.info("What-if 分支 {} 已采纳为主线补丁 {}", id, patch.id());
        return new AdoptResult(patch.id().toString(), branch.file,
                "已变成主线上的待确认补丁，请照常审阅后再应用");
    }

    /** 会话 / 工作区被删时清场（残余影子目录一并丢弃）。 */
    public void discardAllOf(long userId, long workspaceId) {
        for (Branch branch : List.copyOf(branches.values())) {
            if (branch.userId == userId && branch.workspaceId == workspaceId) {
                if (branch.shadowRoot != null) {
                    // 已丢弃 / 已采纳的分支影子早就删了，这里只处理还挂着的
                    shadowService.discard(Path.of(branch.shadowRoot));
                }
                branches.remove(branch.id);
            }
        }
    }

    // ------------------------------------------------------------ 内部

    private Branch require(long userId, String id) {
        Branch branch = branches.get(id);
        if (branch == null || branch.userId != userId) {
            throw new ApiException(ErrorCode.NOT_FOUND, "What-if 分支不存在或已被丢弃");
        }
        return branch;
    }

    private String buildPrompt(String file, String mainText, String question) {
        return """
                你在做一次「反事实实验」：在不动主线代码的前提下，试出另一种写法。

                目标文件：%s
                文件当前内容（每行前缀是行号，仅供你定位，**不要**把它抄进 diff）：
                ```
                %s
                ```

                用户的设想：%s

                要求：
                1. 只输出一个 unified diff，放在 ```diff 代码块里，不要输出任何解释文字；
                2. 只改这一个文件；上下文行必须与上面内容逐字符一致（去掉行号与竖线）；
                3. 改动要完整且能编译：方法签名变了就同步改调用点（在本文件内）；
                4. 这是「另一种设计思路」而不是小修补：如果用户的设想与现有写法本质冲突，就按设想的思路重写相关方法；
                5. 保持项目既有风格（构造器注入、中文注释可以保留原样）。
                """.formatted(file, withLineNumbers(mainText), question.trim());
    }

    /** 同步拿一次完整回答：复用项目里已验证的 TokenStream 模式，避免引入新的模型 API。 */
    private String complete(String prompt) {
        dev.langchain4j.model.chat.StreamingChatModel model = modelGateway.require();
        Assistant assistant = AiServices.builder(Assistant.class)
                .streamingChatModel(model)
                .build();

        StringBuilder answer = new StringBuilder();
        CountDownLatch latch = new CountDownLatch(1);
        RuntimeException[] failure = new RuntimeException[1];
        assistant.chat(prompt)
                .onPartialResponse(answer::append)
                .onCompleteResponse(response -> latch.countDown())
                .onError(error -> {
                    failure[0] = new ApiException(ErrorCode.INTERNAL_ERROR,
                            error == null ? "模型返回错误" : String.valueOf(error.getMessage()));
                    latch.countDown();
                })
                .start();

        try {
            if (!latch.await(LLM_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new ApiException(ErrorCode.INTERNAL_ERROR, "模型在 " + LLM_TIMEOUT_SECONDS + "s 内没有返回");
            }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "等待模型返回时被中断");
        }
        if (failure[0] != null) {
            throw failure[0];
        }
        return answer.toString();
    }

    /** 从模型回答里抽出 diff：优先 ```diff 代码块，退化到第一处 `--- ` 起始段。 */
    static String extractDiff(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        int cursor = 0;
        while (true) {
            int open = raw.indexOf("```", cursor);
            if (open < 0) {
                break;
            }
            int lineEnd = raw.indexOf('\n', open);
            if (lineEnd < 0) {
                break;
            }
            int close = raw.indexOf("```", lineEnd);
            if (close < 0) {
                break;
            }
            String body = raw.substring(lineEnd + 1, close);
            if (body.contains("@@") || body.contains("--- ")) {
                return body.strip();
            }
            cursor = close + 3;
        }
        int start = raw.indexOf("--- ");
        return start >= 0 ? raw.substring(start).strip() : raw.strip();
    }

    private static String withLineNumbers(String text) {
        String[] rows = text.split("\n", -1);
        StringBuilder out = new StringBuilder(text.length() + 64);
        for (int i = 0; i < rows.length; i++) {
            if (i == rows.length - 1 && rows[i].isEmpty()) {
                break;
            }
            out.append(String.format(java.util.Locale.ROOT, "%5d| ", i + 1)).append(rows[i]).append('\n');
        }
        return out.toString();
    }

    private static String normalize(String path) {
        if (path == null) {
            return "";
        }
        String value = path.trim().replace('\\', '/');
        while (value.startsWith("./")) {
            value = value.substring(2);
        }
        while (value.startsWith("/")) {
            value = value.substring(1);
        }
        return value;
    }

    /**
     * 一条反事实分支。影子目录路径不下发前端（那是服务端内部事实）。
     *
     * <p>record 是不可变的，而分支要走完 {@code ready → adopted / discarded} 两段人生，
     * 所以这里挂两个「复制并改一个字段」的小方法，而不是为了可变性把 record 改成普通类 ——
     * 后者会让所有 {@code branch.file()} 调用点都得改写，改一处不如加两行。
     */
    private record Branch(String id, long userId, long workspaceId, long sessionId, String question, String file,
                          String shadowRoot, String mainText, String shadowText, String diff,
                          int added, int removed, String status, String note, Instant createdAt) {

        Branch withStatus(String newStatus, String newNote) {
            return new Branch(id, userId, workspaceId, sessionId, question, file, shadowRoot,
                    mainText, shadowText, diff, added, removed, newStatus, newNote, createdAt);
        }

        /** 影子目录已删除：把路径置空，避免后续重复删除（Path.of(null) 会 NPE）。 */
        Branch withoutShadow() {
            return new Branch(id, userId, workspaceId, sessionId, question, file, null,
                    mainText, shadowText, diff, added, removed, status, note, createdAt);
        }
    }

    /** 仅供 What-if 的「一次性助手」使用：整段 prompt 作为用户消息。 */
    private interface Assistant {
        dev.langchain4j.service.TokenStream chat(String userMessage);
    }
}
