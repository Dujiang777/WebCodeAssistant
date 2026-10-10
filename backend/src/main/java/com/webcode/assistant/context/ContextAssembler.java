package com.webcode.assistant.context;

import com.webcode.assistant.agent.AgentRequest;
import com.webcode.assistant.constitution.ConstitutionService;
import com.webcode.assistant.llm.LlmProperties;
import com.webcode.assistant.workspace.FileContent;
import com.webcode.assistant.workspace.RedzoneService;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.StringJoiner;

/**
 * 组装每次对话的 system prompt。
 *
 * <p>顺序（也是模型读到的优先级）：
 * <ol>
 *   <li>角色与硬约束（{@link SystemPrompts#BASE}）；</li>
 *   <li>执行纪律（{@link SystemPrompts#EXECUTION_DISCIPLINE}）—— 别问许可、别重复问、做完再收尾；</li>
 *   <li>证据引用规则（{@link SystemPrompts#CITATION_RULES}）—— 每句结论必须挂「文件:行号」；</li>
 *   <li>当前模式段落（交付 / 教学，{@link SystemPrompts#modeBlock(String)}）；</li>
 *   <li>项目画像：顶层目录、构建系统、构建文件与 README 片段；</li>
 *   <li>项目规则文件（如 {@code .coding-rules.md}），声明优先级高于默认习惯；</li>
 *   <li>当前打开文件（截断，并明确告知是否被截断）；</li>
 *   <li>用户选中的片段。</li>
 * </ol>
 *
 * <p>历史对话不在这里 —— 那部分交给 LangChain4j 的 ChatMemory 承载，
 * 避免同一份历史在 prompt 里出现两次。
 */
@Component
public class ContextAssembler {

    private static final Logger log = LoggerFactory.getLogger(ContextAssembler.class);

    /** 宪法注入 prompt 的字符预算：约束要全文生效，超长只能截断并明示。 */
    private static final int CONSTITUTION_BUDGET = 6000;

    private final WorkspaceFileService fileService;
    private final ProjectProbe projectProbe;
    private final ConstitutionService constitutionService;
    private final RedzoneService redzoneService;
    private final LlmProperties llmProperties;

    public ContextAssembler(WorkspaceFileService fileService,
                            ProjectProbe projectProbe,
                            ConstitutionService constitutionService,
                            RedzoneService redzoneService,
                            LlmProperties llmProperties) {
        this.fileService = fileService;
        this.projectProbe = projectProbe;
        this.constitutionService = constitutionService;
        this.redzoneService = redzoneService;
        this.llmProperties = llmProperties;
    }

    public String buildSystemPrompt(Workspace workspace, AgentRequest request) {
        ProjectSummary summary = projectProbe.probe(workspace);

        StringBuilder prompt = new StringBuilder();
        prompt.append(SystemPrompts.core(workspace.name(), request.toolProfile()));
        prompt.append(SystemPrompts.CITATION_RULES);
        prompt.append(SystemPrompts.modeBlock(request.normalizedMode()));

        appendProjectSection(prompt, summary);
        appendConstitutionSection(prompt, workspace);
        appendRedzoneSection(prompt, workspace);
        appendRulesSection(prompt, summary);
        appendOpenFileSection(prompt, workspace, request);
        appendSelectionSection(prompt, request);
        return prompt.toString();
    }

    private void appendProjectSection(StringBuilder prompt, ProjectSummary summary) {
        prompt.append("\n## 项目概况\n\n");
        prompt.append("- 工作区名称：").append(summary.projectName()).append('\n');
        prompt.append("- 主语言：").append(summary.primaryLanguage()).append('\n');
        if (summary.buildSystem() != null) {
            prompt.append("- 构建系统：").append(summary.buildSystem()).append('\n');
        }
        if (!summary.topLevelEntries().isEmpty()) {
            prompt.append("- 顶层条目：").append(String.join("、", summary.topLevelEntries())).append('\n');
        }
        if (summary.buildFileExcerpt() != null) {
            prompt.append("\n构建文件开头：\n```\n").append(summary.buildFileExcerpt()).append("\n```\n");
        }
        if (summary.readmeExcerpt() != null) {
            prompt.append("\nREADME 开头：\n```\n").append(summary.readmeExcerpt()).append("\n```\n");
        }
    }

    /**
     * 注入仓库宪法。放在项目画像之后、自动探测的规则文件之前：
     * 宪法是用户逐条写下的硬约束，地位高于一切探测出来的约定；
     * 同时明示「冲突时以宪法为准」，避免模型拿 README 里的旧描述当挡箭牌。
     */
    private void appendConstitutionSection(StringBuilder prompt, Workspace workspace) {
        ConstitutionService.ConstitutionView view = constitutionService.read(workspace);
        if (!view.exists() || view.content() == null || view.content().isBlank()) {
            return;
        }
        String text = view.content();
        boolean clipped = text.length() > CONSTITUTION_BUDGET;
        if (clipped) {
            text = text.substring(0, CONSTITUTION_BUDGET);
        }
        prompt.append("\n## 仓库宪法（用户定义的最高优先级规则）\n\n");
        prompt.append("以下是用户为本仓库写下的硬性规则。**你必须遵守其中每一条**；")
                .append("它与任何其他指引（包括本提示词的默认习惯与项目 README）冲突时，以宪法为准。\n");
        prompt.append("违反宪法的请求应当先指出冲突条款，再给出符合宪法的替代方案。\n\n");
        prompt.append("```markdown\n").append(text).append("\n```\n");
        if (clipped) {
            prompt.append("\n> 注意：宪法已超过 ").append(CONSTITUTION_BUDGET)
                    .append(" 字符被截断。请提醒用户精简宪法（截断的条款你无法遵守）。\n");
        }
    }

    private void appendRedzoneSection(StringBuilder prompt, Workspace workspace) {
        List<String> paths = redzoneService.list(workspace);
        prompt.append("\n## 禁区（硬拒绝，不是建议）\n\n");
        prompt.append("propose_patch 命中下列路径会被系统直接拒绝，不会生成补丁卡：\n");
        prompt.append("- `.wca/CONSTITUTION.md`、`.wca/REDZONE`（系统内置）\n");
        if (paths.isEmpty()) {
            prompt.append("用户还没有额外划禁区。不要建议用户去改上述系统文件。\n");
            return;
        }
        for (String path : paths) {
            prompt.append("- `").append(path).append("`\n");
        }
        prompt.append("不要尝试改这些文件，也不要让用户「先把禁区解开」。绕开禁区用其他文件完成需求。\n");
    }

    private void appendRulesSection(StringBuilder prompt, ProjectSummary summary) {
        if (summary.ruleFileName() == null || summary.ruleFileContent() == null) {
            return;
        }
        prompt.append('\n')
                .append(SystemPrompts.PROJECT_RULES_HEADER.formatted(summary.ruleFileName()))
                .append("\n```markdown\n")
                .append(summary.ruleFileContent())
                .append("\n```\n");
    }

    private void appendOpenFileSection(StringBuilder prompt, Workspace workspace, AgentRequest request) {
        if (request.currentFile() == null || request.currentFile().isBlank()) {
            return;
        }
        prompt.append('\n').append(SystemPrompts.WITH_OPEN_FILE).append('\n');

        FileContent content;
        try {
            content = fileService.read(workspace, request.currentFile());
        } catch (RuntimeException ex) {
            log.debug("读取当前打开文件失败: {}", request.currentFile());
            prompt.append("\n（用户声明的当前文件 ").append(request.currentFile())
                    .append(" 读取失败，请用 list_dir / grep 确认实际路径。）\n");
            return;
        }

        prompt.append("\n当前文件：`").append(content.path()).append("`\n");
        if (content.binary()) {
            prompt.append("（二进制文件，无法展示内容。）\n");
            return;
        }

        String text = content.content() == null ? "" : content.content();
        AgentRequest.Selection selection = request.selection();
        boolean focused = selection != null && !selection.isEmpty() && selection.startLine() != null;
        if (focused) {
            int start = selection.startLine();
            int end = selection.endLine() == null ? start : selection.endLine();
            prompt.append("当前文件摘录（选区前后约 40 行，不是全文）。解释/问答请直接看下面的选区，")
                    .append("不要再 read_file 整份文件。\n");
            prompt.append("```").append(content.language()).append('\n')
                    .append(windowAround(text, start, end, 40)).append("\n```\n");
            return;
        }

        int budget = llmProperties.contextFileChars();
        boolean clipped = text.length() > budget;
        if (clipped) {
            text = text.substring(0, budget);
        }
        prompt.append("```").append(content.language()).append('\n').append(text).append("\n```\n");
        if (clipped || content.truncated()) {
            prompt.append("\n> 注意：上面的文件内容已被截断（原文件 ").append(content.sizeBytes())
                    .append(" 字节）。如需查看后面的部分，请用 read_file 分次读取，"
                            + "不要基于截断内容假设文件只有这么长。\n");
        }
    }

    private static String windowAround(String text, int startLine, int endLine, int pad) {
        String[] lines = text.split("\n", -1);
        int from = Math.max(1, startLine - pad);
        int to = Math.min(lines.length, Math.max(startLine, endLine) + pad);
        StringBuilder out = new StringBuilder();
        for (int i = from; i <= to; i++) {
            if (i > from) {
                out.append('\n');
            }
            out.append(lines[i - 1]);
        }
        return out.toString();
    }

    private void appendSelectionSection(StringBuilder prompt, AgentRequest request) {
        AgentRequest.Selection selection = request.selection();
        if (selection == null || selection.isEmpty()) {
            return;
        }
        prompt.append("\n## 用户选中的代码\n\n");
        StringJoiner range = new StringJoiner("-");
        if (selection.startLine() != null) {
            range.add(String.valueOf(selection.startLine()));
            if (selection.endLine() != null && !selection.endLine().equals(selection.startLine())) {
                range.add(String.valueOf(selection.endLine()));
            }
        }
        if (range.length() > 0) {
            prompt.append("范围：第 ").append(range).append(" 行\n");
        }
        String text = selection.text() == null ? "" : selection.text();
        if (text.length() > llmProperties.contextSelectionChars()) {
            text = text.substring(0, llmProperties.contextSelectionChars()) + "\n…（已截断）";
        }
        prompt.append("```\n").append(text).append("\n```\n");
        prompt.append("选区全文已在上面。本轮若用户是在问这段代码（解释、风险、谁在用），")
                .append("**直接回答**：禁止 set_plan，禁止再 read_file 整文件，")
                .append("禁止 propose_patch 去顺手完成上一轮没做完的事。")
                .append("只有用户明确要求改这段时才出补丁。\n");
    }
}
