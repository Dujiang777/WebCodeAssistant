package com.webcode.assistant.agent;

import com.webcode.assistant.build.BuildService;
import com.webcode.assistant.build.CompileIssue;
import com.webcode.assistant.build.TestRunResult;
import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.map.SpringMapService;
import com.webcode.assistant.semantic.SemanticHit;
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
    private final BuildService buildService;
    private final SpringMapService springMapService;
    private final com.webcode.assistant.semantic.SemanticIndexService semanticService;
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
                        BuildService buildService,
                        SpringMapService springMapService,
                        com.webcode.assistant.semantic.SemanticIndexService semanticService,
                        AppProperties appProperties,
                        long sessionId,
                        int maxToolSteps) {
        this.workspace = workspace;
        this.publisher = publisher;
        this.fileService = fileService;
        this.grepService = grepService;
        this.patchService = patchService;
        this.blastRadiusService = blastRadiusService;
        this.buildService = buildService;
        this.springMapService = springMapService;
        this.semanticService = semanticService;
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
              - 一次调用只能改一个文件；改动跨多个文件时，在本轮内连续多次调用把相关补丁
                全部提交（例如「接口 + 实现 + 测试」三件套），用户可以在前端一键批量应用；
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

    // ------------------------------------------------------------ run_tests

    @Tool(name = "run_tests", value = """
            在工作区里运行测试套件（Maven `test` / Gradle `test`，按项目构建方式自动选择，你无法指定其他 goal）。
            返回：每个失败用例的类名 / 方法 / 行号 / 失败信息，以及通过数与失败数的汇总。
            典型用法（测试失败驱动改代码）：先 run_tests 拿到真实失败 → read_file 打开相关源码与测试
            → propose_patch 给出最小修复 → 建议用户应用后再跑一次测试确认。
            注意：首次运行可能要下载依赖，耗时较长；工作区没有测试时会明确告诉你。
            """)
    public String runTests() {
        return guard("run_tests", Map.of(), () -> {
            TestRunResult result = buildService.runTests(workspace);
            StringBuilder out = new StringBuilder();
            out.append("状态: ").append(result.status())
                    .append(" | 构建系统: ").append(result.buildSystem())
                    .append(" | 退出码: ").append(result.exitCode() == null ? "未执行" : result.exitCode())
                    .append(" | 耗时: ").append(result.durationMs() / 1000.0).append("s\n");
            out.append("命令: ").append(result.command()).append('\n');
            if (result.totals() != null) {
                out.append("用例统计: 共 ").append(result.totals().run())
                        .append(" 个，失败 ").append(result.totals().failures())
                        .append("，错误 ").append(result.totals().errors())
                        .append(result.totals().skipped() == null ? "" :
                                "，跳过 " + result.totals().skipped())
                        .append('\n');
            }
            if (result.failures().isEmpty() && !result.issues().isEmpty()) {
                out.append("测试代码编译不过（").append(result.issues().size())
                        .append(" 条诊断），测试套件没有执行：\n");
                for (CompileIssue issue : result.issues()) {
                    out.append("- ").append(issue.file());
                    if (issue.line() != null) {
                        out.append(':').append(issue.line());
                    }
                    out.append("  ").append(issue.message()).append('\n');
                }
                out.append("\n这些是编译错误而不是断言失败 —— 通常是你改了主代码签名、"
                        + "测试代码还没跟上。请先 read_file 打开出错的测试文件，"
                        + "用 propose_patch 让它适配新的构造器/方法签名。");
            } else if (result.failures().isEmpty()) {
                out.append("失败用例: 无");
                out.append(TestRunResult.OK.equals(result.status())
                        ? "。所有测试通过。" : "（没有解析到具体用例，请看输出尾部）");
                out.append('\n');
            } else {
                out.append("失败用例（").append(result.failures().size()).append(" 个）：\n");
                for (TestRunResult.TestFailure failure : result.failures()) {
                    out.append("- ").append(failure.displayName());
                    if (failure.line() != null) {
                        out.append(':').append(failure.line());
                    }
                    out.append("  ").append(failure.message()).append('\n');
                }
                out.append("\n请先 read_file 打开上面列出的测试与其测试的源码类，"
                        + "确认是「实现错了」还是「测试断言过时」，再用 propose_patch 修复。"
                        + "修复后建议用户再跑一次测试验证。");
            }
            out.append('\n').append(result.note());
            String uiSummary = TestRunResult.OK.equals(result.status())
                    ? (result.totals() == null ? "测试通过" : result.totals().run() + " 个用例全部通过")
                    : result.failures().size() + " 个测试失败";
            return outcome(out.toString(), uiSummary
                    + (TestRunResult.OK.equals(result.status()) ? "" : "（exit=" + result.exitCode() + "）"));
        });
    }

    // ------------------------------------------------------------ spring_map

    @Tool(name = "spring_map", value = """
            扫描工作区里的 Spring 构造型组件（@RestController / @Controller / @Service / @Repository /
            @Component / @Configuration / @Entity 等），返回每个 Bean 的类型、所在文件与行号、
            暴露的 HTTP 端点（类级前缀 + 方法级映射拼接），以及构造器注入形成的依赖关系。
            用于回答「这个项目有哪些接口」「某个 Service 被谁注入」「请求从哪个 Controller 进来」
            这类全局结构问题。所有节点都带 文件:行号，可以直接引用给用户。
            非 Spring 项目会明确返回「没有发现组件」，不要对这类项目编造地图。
            """)
    public String springMap() {
        return guard("spring_map", Map.of(), () -> {
            SpringMapService.SpringMapData data = springMapService.scan(workspace);
            StringBuilder out = new StringBuilder();
            out.append("Spring 地图 | 扫描 ").append(data.scannedFiles()).append(" 个 Java 文件")
                    .append(data.truncated() ? "（已截断）" : "")
                    .append(" | ").append(data.note()).append('\n');
            if (data.nodes().isEmpty()) {
                return outcome(out.toString(), "未发现 Spring 组件");
            }
            String currentLayer = null;
            for (SpringMapService.Node node : data.nodes()) {
                if (!node.layer().equals(currentLayer)) {
                    currentLayer = node.layer();
                    out.append("\n== ").append(layerLabel(currentLayer)).append(" ==\n");
                }
                out.append(node.name()).append("  (").append(node.file()).append(':').append(node.line()).append(')');
                if (node.endpoints().isEmpty()) {
                    out.append("  [无 HTTP 端点]");
                } else {
                    out.append("  [").append(String.join("; ", node.endpoints())).append(']');
                }
                List<String> deps = data.edges().stream()
                        .filter(edge -> edge.from().equals(node.name()))
                        .map(SpringMapService.Edge::to)
                        .toList();
                if (!deps.isEmpty()) {
                    out.append("  依赖: ").append(String.join("、", deps));
                }
                out.append('\n');
            }
            return outcome(out.toString(), data.nodes().size() + " 个 Bean / "
                    + data.edges().size() + " 条依赖");
        });
    }

    private static String layerLabel(String layer) {
        return switch (layer) {
            case "0-config" -> "配置";
            case "1-web" -> "Web 层（Controller）";
            case "2-service" -> "服务层（Service）";
            case "3-repository" -> "数据访问层（Repository）";
            case "4-model" -> "模型（Entity）";
            default -> "其他组件";
        };
    }

    // ------------------------------------------------------------ semantic_search

    @Tool(name = "semantic_search", value = """
            语义检索：用自然语言描述「想找哪段逻辑」，按向量相似度返回最相关的代码块（文件 + 行号 + 内容 + 分数）。
            与 grep 的分工：grep 适合精确关键字（找 ERROR_PATTERN 这种标识符）；semantic_search 适合
            「限流在哪做的」「哪里处理过期 token」这类说不准具体词的问题。
            结果可以配合 read_file 查看上下文，再决定是否 propose_patch。
            未建索引或未配置 embedding 模型时会明确返回 unavailable —— 此时改用 grep，不要凭空编造。
            """)
    public String semanticSearch(@P("自然语言查询，例如「数据库连接池在哪配置」") String query) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("query", nullSafe(query));
        return guard("semantic_search", args, () -> {
            SemanticHit.Result result = semanticService.search(workspace,
                    query == null ? "" : query, 8);
            if (!SemanticHit.OK.equals(result.status())) {
                return outcome("语义检索不可用（" + result.status() + "）：" + result.note()
                        + "\n请改用 grep 按关键字检索。", "语义检索不可用");
            }
            if (result.hits().isEmpty()) {
                return outcome("没有找到相关代码块。可以换一种描述再试，或改用 grep 精确关键字。",
                        "无结果");
            }
            StringBuilder out = new StringBuilder("语义检索结果（余弦相似度，已按相关度排序）:\n");
            for (SemanticHit hit : result.hits()) {
                out.append(String.format("- %s:%d-%d (score=%.3f)%n", hit.path(), hit.startLine(),
                        hit.endLine(), hit.score()));
                String preview = hit.content().strip();
                if (preview.length() > 240) {
                    preview = preview.substring(0, 240) + "…";
                }
                out.append("  ").append(preview.replace("\n", "\n  ")).append('\n');
            }
            out.append("\n用 read_file 查看完整上下文后再决定下一步。");
            return outcome(out.toString(), result.hits().size() + " 个相关代码块");
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
