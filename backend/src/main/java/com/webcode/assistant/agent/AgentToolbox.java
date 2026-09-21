package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.workspace.FileContent;
import com.webcode.assistant.workspace.FileNode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Agent 可用的四个工具。<b>这是模型唯一能触碰工作区的入口</b>。
 *
 * <p>设计约束：
 * <ul>
 *   <li>全部是<b>只读</b>或<b>产出补丁</b>，没有任何一个方法能写盘、删盘、执行命令。
 *       模型无法在服务进程里跑任意命令，这是硬边界；</li>
 *   <li>每个工具都在方法体开头发出 {@code tool_call} 事件、结束时发出 {@code tool_result}，
 *       所以前端能实时看到「读了哪个文件、搜了什么」—— 这比事后回放工具轨迹更有用；</li>
 *   <li>工具内部<b>捕获异常并返回错误文本</b>，而不是把异常抛给框架。这样模型总能拿到一次
 *       工具结果，可以据此自我修正（例如补丁上下文不匹配时重新 read_file），
 *       而不是让整个回合直接失败。</li>
 * </ul>
 *
 * <p>每次对话都会 new 一个实例（绑定到具体的 workspace 与 SSE 发布口），因此不是 Spring Bean。
 */
public class AgentToolbox {

    private static final Logger log = LoggerFactory.getLogger(AgentToolbox.class);
    private static final int LIST_DIR_MAX_ENTRIES = 500;
    private static final int READ_FILE_MAX_LINES_REPORTED = 100_000;

    private final Workspace workspace;
    private final ChatEventPublisher publisher;
    private final WorkspaceFileService fileService;
    private final GrepService grepService;
    private final PatchService patchService;
    private final BlastRadiusService blastRadiusService;
    private final AppProperties appProperties;
    private final long sessionId;
    private final int maxToolSteps;

    /** 本轮已执行的工具调用次数，用于封顶，避免模型在死循环里烧 token。 */
    private final AtomicInteger toolCalls = new AtomicInteger();

    /** 本轮生成的补丁，回合结束后统一挂到 assistant 消息上。 */
    private final List<UUID> proposedPatches = new ArrayList<>();

    public AgentToolbox(Workspace workspace,
                        ChatEventPublisher publisher,
                        WorkspaceFileService fileService,
                        GrepService grepService,
                        PatchService patchService,
                        BlastRadiusService blastRadiusService,
                        AppProperties appProperties,
                        long sessionId,
                        int maxToolSteps) {
        this.workspace = workspace;
        this.publisher = publisher;
        this.fileService = fileService;
        this.grepService = grepService;
        this.patchService = patchService;
        this.blastRadiusService = blastRadiusService;
        this.appProperties = appProperties;
        this.sessionId = sessionId;
        this.maxToolSteps = maxToolSteps;
    }

    public List<UUID> proposedPatches() {
        return List.copyOf(proposedPatches);
    }

    // ------------------------------------------------------------ list_dir

    @Tool(name = "list_dir", value = """
            列出工作区内某个目录的直接子项（不递归）。用于了解项目结构。
            参数 path 是相对工作区根的目录路径，根目录传 "." 或空字符串。
            返回每一项的类型（dir/file）与大小。已被忽略的目录（.git、node_modules、target、build 等）不会出现。
            """)
    public String listDir(@P("相对工作区根的目录路径，根目录传 \".\"") String path) {
        return guard("list_dir", Map.of("path", nullSafe(path)), () -> {
            String directory = normalizeDirPath(path);
            List<FileNode> children = fileService.listDirectory(workspace, directory);

            StringBuilder out = new StringBuilder();
            out.append("目录: ").append(directory.isEmpty() ? "." : directory)
                    .append("（").append(children.size()).append(" 个直接子项）\n");
            int shown = Math.min(children.size(), LIST_DIR_MAX_ENTRIES);
            for (int i = 0; i < shown; i++) {
                FileNode child = children.get(i);
                if ("dir".equals(child.type())) {
                    out.append("dir  ").append(child.name()).append("/\n");
                } else {
                    out.append("file ").append(child.name())
                            .append("  (").append(formatSize(child.size())).append(")\n");
                }
            }
            if (children.size() > shown) {
                out.append("… 其余 ").append(children.size() - shown).append(" 项已省略\n");
            }
            if (children.isEmpty()) {
                out.append("（空目录）\n");
            }
            return outcome(out.toString(), children.size() + " 个直接子项");
        });
    }

    // ------------------------------------------------------------ read_file

    @Tool(name = "read_file", value = """
            读取工作区内某个文件的文本内容。参数 path 是相对工作区根的文件路径，
            例如 "src/main/java/com/demo/UserService.java"。

            返回的每一行都带行号，形如 `   42| public User find(long id) {`。
            行号用于你在回答里标注出处（格式 `路径:行号`），**不要**把行号或那条竖线
            复制进你生成的 diff —— diff 的上下文行必须是文件的原始内容，不带行号。

            超过单次读取上限时会截断，返回内容里会明确标注 truncated=true 与原文件大小；
            此时不要假设文件只有这么长，需要后续部分请调整范围或用 grep 定位。
            """)
    public String readFile(@P("相对工作区根的文本文件路径") String path) {
        return guard("read_file", Map.of("path", nullSafe(path)), () -> {
            FileContent content = fileService.read(workspace, path);
            if (content.binary()) {
                return outcome("文件 " + content.path() + " 是二进制文件（" + formatSize(content.sizeBytes())
                        + "），无法以文本形式读取。", "二进制文件，已跳过");
            }
            String text = content.content() == null ? "" : content.content();
            long lines = text.isEmpty() ? 0 : text.lines().count();
            StringBuilder out = new StringBuilder();
            out.append("文件: ").append(content.path()).append('\n');
            out.append("语言: ").append(content.language())
                    .append(" | 大小: ").append(formatSize(content.sizeBytes()))
                    .append(" | 行数: ").append(Math.min(lines, READ_FILE_MAX_LINES_REPORTED));
            if (content.truncated()) {
                out.append("\n⚠ truncated=true：内容已被截断，实际文件更大。");
            }
            out.append("\n```").append(content.language()).append('\n').append(numberLines(text));
            if (!text.isEmpty() && !text.endsWith("\n")) {
                out.append('\n');
            }
            out.append("```\n");
            out.append("（左侧数字是行号，仅供你引用时写 `").append(content.path())
                    .append(":行号`；生成 diff 时请勿带上行号。）\n");
            if (content.truncated()) {
                out.append("提示：如需查看后半部分，请先 grep 定位行号，再针对性读取；"
                        + "不要基于截断内容判断文件已经结束。\n");
            }
            return outcome(out.toString(), lines + " 行 / " + formatSize(content.sizeBytes())
                    + (content.truncated() ? "（已截断）" : ""));
        });
    }

    /**
     * 给每行加上 `行号|` 前缀。
     *
     * <p>这么做是为了让模型的引用能精确到行 —— 没有行号，它只能靠估算，
     * 而估算出来的行号会把用户带到错误的位置，比不给引用更糟。
     * 行号宽度固定为 5 位，方便模型对齐，也方便人眼扫。
     */
    private static String numberLines(String text) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder(text.length() + 64);
        String[] rows = text.split("\n", -1);
        for (int i = 0; i < rows.length; i++) {
            // 末尾因 split 产生的空串：原文本以 \n 结尾时不再补一行
            if (i == rows.length - 1 && rows[i].isEmpty()) {
                break;
            }
            sb.append(String.format(java.util.Locale.ROOT, "%5d| ", i + 1)).append(rows[i]).append('\n');
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- grep

    @Tool(name = "grep", value = """
            在工作区内按正则表达式搜索文件内容，返回「文件路径:行号:该行内容」。
            用于定位类、方法、配置项的所有出现位置。优先使用精确的标识符而不是宽泛的词。
            参数：
              pattern  正则表达式（Java / ripgrep 语法）
              path     搜索范围，相对工作区根的目录或文件，根目录传 "."，可省略
              glob     可选，按文件名过滤，例如 "*.java" 或 "**/*.xml"
            结果条数有上限，若被截断会明确标注；上限内没有匹配时会明确说明「没有任何匹配」。
            """)
    public String grep(@P("正则表达式") String pattern,
                       @P("搜索范围，相对工作区根，根目录传 \".\"，可省略") String path,
                       @P("可选的文件名 glob 过滤器，例如 *.java") String glob) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("pattern", nullSafe(pattern));
        args.put("path", nullSafe(path));
        args.put("glob", nullSafe(glob));
        return guard("grep", args, () -> {
            String scope = (path == null || path.isBlank()) ? "." : path;
            GrepResult result = grepService.search(workspace, pattern, scope, glob);
            StringBuilder out = new StringBuilder();
            out.append("模式: ").append(pattern)
                    .append(" | 范围: ").append(scope)
                    .append(" | 引擎: ").append(result.engine())
                    .append(" | 匹配: ").append(result.count()).append(" 处\n");
            if (result.truncated()) {
                out.append("⚠ 结果已被截断（条数上限 ").append(appProperties.grepMaxResults())
                        .append("），请缩小 pattern 或 path 范围。\n");
            }
            if (result.count() == 0) {
                out.append("没有任何匹配。\n");
            } else {
                for (GrepResult.GrepMatch match : result.matches()) {
                    out.append(match.file()).append(':').append(match.line())
                            .append(": ").append(match.text()).append('\n');
                }
            }
            return outcome(out.toString(), result.count() + " 处匹配"
                    + (result.truncated() ? "（已截断）" : ""));
        });
    }

    // -------------------------------------------------------- propose_patch

    @Tool(name = "propose_patch", value = """
            生成一个**待用户确认**的代码补丁。这是修改代码的唯一方式，你不会直接写文件。
            参数：
              file    相对工作区根的目标文件路径
              diff    unified diff 文本，必须包含 @@ 变更块；建议带上 --- / +++ 文件头。
                      --- 一侧写 a/原路径，+++ 一侧写 b/目标路径；新建文件用 --- /dev/null。
                      上下文行（空格开头）必须与文件当前内容逐字符一致。
              summary 一句话说明这个补丁做了什么（给用户看，中文）
            约束：
              - 一次调用只能改一个文件，改多个文件请分多次调用；
              - 补丁会先做一次「能否干净应用」的校验，校验不通过会把原因告诉你，
                此时请重新 read_file 获取最新内容后再次调用，不要重复提交同样的 diff；
              - 用户点「应用」之后才会真正写盘；在用户确认前不要重复提交同一补丁。
            """)
    public String proposePatch(@P("相对工作区根的目标文件路径") String file,
                               @P("unified diff 文本") String diff,
                               @P("一句话中文说明这个补丁做了什么") String summary) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file", nullSafe(file));
        args.put("summary", nullSafe(summary));
        args.put("diff", abbreviateForEvent(diff));
        return guard("propose_patch", args, () -> {
            Patch patch = patchService.propose(sessionId, null, workspace, file, diff);
            proposedPatches.add(patch.id());

            // 先推给前端：用户能立刻看到 diff 并决定是否应用
            publisher.patch(patch.id().toString(), patch.filePath(), patch.diffText());

            int added = 0;
            int removed = 0;
            try {
                var filePatch = UnifiedDiffParser.parse(patch.diffText(), patch.filePath()).get(0);
                added = filePatch.addedLines();
                removed = filePatch.removedLines();
            } catch (RuntimeException ex) {
                log.debug("统计补丁行数失败: {}", ex.getMessage());
            }
            String uiSummary = "+" + added + " / -" + removed + " · " + patch.filePath();

            // 顺手把影响面回给模型：用户会在卡片上看到风险条，模型也应该知道同样的事实，
            // 这样它能在说明里主动提醒「这碰到了鉴权代码」，而不是让用户自己去发现。
            String impact;
            try {
                impact = blastRadiusService.describeForModel(
                        blastRadiusService.compute(workspace, patch.filePath(), patch.diffText()));
            } catch (RuntimeException ex) {
                log.debug("影响面分析失败: {}", ex.getMessage());
                impact = "（影响面分析未能完成）";
            }

            String modelResult = """
                    补丁已生成，正在等待用户确认。
                    patchId: %s
                    文件: %s
                    变更: +%d 行 / -%d 行
                    说明: %s

                    %s

                    用户会在编辑器里看到 diff 并自行决定是否应用。请用一句话告诉用户这个补丁改了什么，
                    **不要**再重复输出 diff 内容，也不要重复提交同一个补丁。
                    """.formatted(patch.id(), patch.filePath(), added, removed,
                    summary == null || summary.isBlank() ? "（未提供）" : summary, impact);
            return outcome(modelResult, uiSummary);
        });
    }

    // ------------------------------------------------------------ 内部机制

    /**
     * 统一的「发事件 → 执行 → 发结果」包装。
     * 异常在这里被转成给模型看的文本，保证任何情况下模型都能拿到一次工具结果。
     */
    private String guard(String toolName, Map<String, Object> args, Supplier<ToolOutcome> action) {
        publisher.toolCall(toolName, args);

        // 步数上限：不是硬中断（框架层没有暴露中断点），而是把工具变成「不可用」，
        // 模型拿到这个结果后基本都会收敛到最终回答。真正的硬约束见 README「已知限制」。
        if (toolCalls.incrementAndGet() > maxToolSteps) {
            String limitMessage = "已达到本轮工具调用上限（" + maxToolSteps + " 次）。"
                    + "请立即基于已有信息给出最终回答，不要再调用工具。";
            publisher.toolResult(toolName, false, limitMessage);
            return "工具执行失败 -> " + limitMessage;
        }

        try {
            ToolOutcome outcome = action.get();
            publisher.toolResult(toolName, true, outcome.uiSummary());
            return outcome.modelResult();
        } catch (ApiException ex) {
            String message = ex.code().name() + ": " + ex.getMessage();
            publisher.toolResult(toolName, false, message);
            log.debug("工具 {} 业务失败: {}", toolName, message);
            return "工具执行失败 -> " + message + "\n请根据这个原因调整参数后重试；不要编造文件内容或路径。";
        } catch (RuntimeException ex) {
            String message = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            publisher.toolResult(toolName, false, message);
            log.warn("工具 {} 内部错误", toolName, ex);
            return "工具执行失败 -> 内部错误: " + message;
        }
    }

    private ToolOutcome outcome(String modelResult, String uiSummary) {
        return new ToolOutcome(modelResult, uiSummary);
    }

    /** 工具返回值：需要分别给「模型看的完整结果」和「UI 卡片上那一行摘要」。 */
    private record ToolOutcome(String modelResult, String uiSummary) {
    }

    /** 把用户/模型传入的目录路径归一化成相对路径（去掉 ./ 与前导斜杠）。 */
    private String normalizeDirPath(String path) {
        if (path == null) {
            return "";
        }
        String normalized = path.trim().replace('\\', '/');
        while (normalized.startsWith("./")) {
            normalized = normalized.substring(2);
        }
        if (".".equals(normalized) || "/".equals(normalized)) {
            return "";
        }
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private static String nullSafe(String value) {
        return value == null ? "" : value;
    }

    /** 事件里的 diff 只作为「参数展示」，完整 diff 走 patch 事件，避免同一条内容传两遍。 */
    private static String abbreviateForEvent(String diff) {
        if (diff == null) {
            return "";
        }
        return diff.length() > 400 ? diff.substring(0, 400) + "\n…（完整 diff 见 patch 事件）" : diff;
    }

    private static String formatSize(Long bytes) {
        if (bytes == null) {
            return "0 B";
        }
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format(java.util.Locale.ROOT, "%.1f KB", bytes / 1024.0);
        }
        return String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0);
    }
}
