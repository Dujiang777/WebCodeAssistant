package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspaceService;
import com.webcode.assistant.workspace.diff.FilePatch;
import com.webcode.assistant.workspace.diff.Hunk;
import com.webcode.assistant.workspace.diff.HunkLine;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 特性开关强制包裹 —— 功能 16。
 *
 * <p><b>产品立场：</b>企业 Java 最痛的从来不是「AI 改得不对」，而是「AI 改完无法灰度」。
 * 所以这里的默认规则是：<b>任何行为变化都必须能被一键关掉</b>，并且关闭时必须还能跑回
 * 改动前的旧路径 —— 说得出旧路径长什么样，才算真的能回退。
 *
 * <p>产出四样东西（全部是确定性的，不依赖模型，因此可被自检断言）：
 * <ol>
 *   <li>{@code flagKey} + {@code configLine}：开关名与可直接粘进 application.yml 的配置；</li>
 *   <li>{@code legacyCode}：<b>开关关闭时跑的旧实现</b>，从当前磁盘内容里按方法签名 + 花括号配平抽出来，
 *       与改动前逐字符一致；</li>
 *   <li>{@code wrappedSnippet}：把新增逻辑与旧逻辑分别放进 if / else 的包裹骨架（缩进已按 +4 调整）；</li>
 *   <li>开 / 关两种<b>运行说明</b>：包括灰度顺序建议。</li>
 * </ol>
 *
 * <p><b>与「拦一道」的分工：</b>功能 14 拦的是写操作本身（意图层），这里拦的是<b>应用补丁</b>这一步 ——
 * 行为变化没有确认「我知道关掉开关后跑哪条路径」就不允许落盘（{@code FLAG_ACK_REQUIRED}）。
 * 判定不出来的（纯注释、import、测试代码、非源码）一律不拦，避免把开关变成噪音。
 */
@Service
public class FeatureFlagService {

    private static final Logger log = LoggerFactory.getLogger(FeatureFlagService.class);

    /** 单文件读取上限：只为了抽取旧方法体，8MB 与可打补丁上限一致。 */
    private static final long READ_LIMIT = 8L * 1024 * 1024;

    private static final Pattern METHOD_SIGNATURE = Pattern.compile(
            "^\\s*(?:public|private|protected)\\s+(?:[\\w<>\\[\\],\\s\\.@]+\\s+)?(\\w+)\\s*\\(");

    private static final Pattern CONTROL_KEYWORDS = Pattern.compile(
            "^\\s*(if|for|while|switch|catch|return|new|assert)\\b");

    private final PatchRepository patchRepository;
    private final ChatSessionRepository sessionRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceFileService fileService;

    public FeatureFlagService(PatchRepository patchRepository,
                              ChatSessionRepository sessionRepository,
                              WorkspaceService workspaceService,
                              WorkspaceFileService fileService) {
        this.patchRepository = patchRepository;
        this.sessionRepository = sessionRepository;
        this.workspaceService = workspaceService;
        this.fileService = fileService;
    }

    /** 开关包裹的对外视图 —— 前端 {@code FeatureFlagCard} 直接渲染。 */
    public record FlagView(String patchId, String file, boolean required, String reason,
                           String flagKey, String defaultValue, String mode, String targetMethod,
                           String legacyCode, String wrappedSnippet, String configLine,
                           String openRunbook, String closedRunbook,
                           List<String> addedLines, List<String> removedLines, String notice) {
    }

    /** 该补丁是否必须先确认开关语义才能应用（PatchService 应用前的唯一判据）。 */
    public boolean requiresAcknowledgement(long userId, UUID patchId) {
        return analyze(userId, patchId).required();
    }

    /**
     * 分析一个补丁的开关语义。
     *
     * <p>无论是否 required 都会返回完整视图：不需要开关时前端展示「为什么不需要」，
     * 而不是空着 —— 让规则可见，用户才不会觉得这是随机弹窗。
     */
    public FlagView analyze(long userId, UUID patchId) {
        Patch patch = requireOwned(userId, patchId);
        String file = patch.filePath();
        String diff = patch.diffText();

        List<HunkLine> lines = new ArrayList<>();
        try {
            FilePatch parsed = UnifiedDiffParser.parse(diff, file).get(0);
            for (Hunk hunk : parsed.hunks()) {
                for (HunkLine line : hunk.lines()) {
                    if (!line.isContext()) {
                        lines.add(line);
                    }
                }
            }
        } catch (RuntimeException ex) {
            log.debug("补丁 {} 解析失败，按「不需要开关」处理: {}", patchId, ex.getMessage());
        }

        List<String> addedCode = new ArrayList<>();
        List<String> removedCode = new ArrayList<>();
        for (HunkLine line : lines) {
            if (line.isAdded() && isCode(line.text())) {
                addedCode.add(line.text());
            } else if (line.isRemoved() && isCode(line.text())) {
                removedCode.add(line.text());
            }
        }

        String normalized = file.replace('\\', '/');
        boolean javaSource = normalized.endsWith(".java");
        boolean testSource = normalized.contains("/src/test/") || normalized.startsWith("src/test/");
        boolean required = javaSource && !testSource && !addedCode.isEmpty();

        String reason = !javaSource
                ? "不是 Java 源码（" + file + "），开关对配置 / 文档 / 前端资源没有意义"
                : testSource
                        ? "这是测试代码，不参与灰度，不需要开关"
                        : addedCode.isEmpty()
                                ? "这次改动只涉及注释、空行或 import，没有行为变化"
                                : "往 " + file + " 增加了 " + addedCode.size() + " 行可执行代码 —— 属于行为变化，必须能一键关掉";

        String targetMethod = detectMethod(lines);
        String slug = slugOf(file, targetMethod);
        String flagKey = "wca.feature." + slug;
        String configLine = "wca:\n  feature:\n    " + slug + ": false";

        String current = readCurrent(userId, patch, file);
        String legacyCode = extractLegacyCode(current, targetMethod, removedCode);
        String wrappedSnippet = buildWrappedSnippet(flagKey, lines);
        String mode = normalized.contains("Configuration") ? "conditional" : "runtime";

        String openRunbook = """
                【打开】在 application.yml 里写入 `%s: true`（或启动参数 `--%s=true`），
                或只对某台实例打开做金丝雀。此时执行的是本补丁的新逻辑：%s
                """.formatted(flagKey, flagKey,
                patchTargetSummary(patch)).strip();

        String closedRunbook = """
                【关闭】保持 `%s: false`（默认值，即什么都不配）时，跑的是<b>改动前的旧实现</b>，
                也就是下面「旧路径」里那段代码 —— 它与这次改动之前的文件内容逐字符一致，
                所以关掉开关等价于回到改动前，不需要回滚代码、不需要重新发版。
                灰度建议：先在预发打开 → 观察 P99 与错误率 → 再逐步放量；出问题直接改配置关闭。
                """.formatted(flagKey).strip();

        String notice = required
                ? "这个补丁改动了运行行为，必须先确认「关掉开关后跑哪条路径」才能应用。"
                : "这个补丁不涉及行为变化，可以直接应用。";

        return new FlagView(patchId.toString(), file, required, reason, flagKey, "false", mode,
                targetMethod == null ? "（未识别到方法边界）" : targetMethod,
                legacyCode, wrappedSnippet, configLine, openRunbook, closedRunbook,
                List.copyOf(addedCode), List.copyOf(removedCode), notice);
    }

    // ------------------------------------------------------------ 内部

    /** 一行算不算「可执行代码」：注释、空行、import、package、注解壳都不算。 */
    static boolean isCode(String text) {
        if (text == null) {
            return false;
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
                || trimmed.startsWith("import ") || trimmed.startsWith("package ")
                || trimmed.equals("}") || trimmed.equals("{"));
    }

    /** 从 diff 的上下文里推断改动所在的方法名（取最后一个匹配的签名）。 */
    static String detectMethod(List<HunkLine> lines) {
        String method = null;
        for (HunkLine line : lines) {
            if (CONTROL_KEYWORDS.matcher(line.text()).find()) {
                continue;
            }
            Matcher matcher = METHOD_SIGNATURE.matcher(line.text());
            if (matcher.find()) {
                method = matcher.group(1);
            }
        }
        return method;
    }

    /** 开关名 slug：文件名 + 方法名，例 user-service-find-by-id。 */
    static String slugOf(String file, String method) {
        String name = file.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        if (name.endsWith(".java")) {
            name = name.substring(0, name.length() - 5);
        }
        String base = camelToKebab(name);
        if (method != null && !method.isBlank()) {
            base = base + "-" + camelToKebab(method);
        }
        if (base.length() > 60) {
            base = base.substring(0, 60);
        }
        return base.isBlank() ? "unnamed-change" : base;
    }

    static String camelToKebab(String value) {
        return value.replaceAll("([a-z0-9])([A-Z])", "$1-$2")
                .replaceAll("[^A-Za-z0-9-]", "-")
                .replaceAll("-{2,}", "-")
                .toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * 抽取「旧路径」：优先按方法签名做花括号配平拿到整个方法体；
     * 拿不到就退回 diff 里的删除行（并注明只是被替换的行）。
     */
    static String extractLegacyCode(String current, String method, List<String> removedCode) {
        if (current != null && method != null) {
            String body = methodBody(current, method);
            if (body != null) {
                return body;
            }
        }
        if (removedCode.isEmpty()) {
            return "// 这个补丁只有新增，没有替换掉任何旧代码（旧路径就是原来的调用方，无需改动）";
        }
        return String.join("\n", removedCode);
    }

    /** 文本级方法体提取：找到签名行后做花括号配平。注释与字符串里的括号会带来偏差，但用于展示足够稳。 */
    static String methodBody(String source, String method) {
        String[] rows = source.split("\n", -1);
        int start = -1;
        for (int i = 0; i < rows.length; i++) {
            Matcher matcher = METHOD_SIGNATURE.matcher(rows[i]);
            if (matcher.find() && method.equals(matcher.group(1))) {
                // 取最后一个匹配（同名重载取后者，通常是最贴近改动的实现）
                start = i;
            }
        }
        if (start < 0) {
            return null;
        }
        int depth = 0;
        boolean opened = false;
        StringBuilder out = new StringBuilder();
        for (int i = start; i < rows.length; i++) {
            out.append(rows[i]).append('\n');
            for (char ch : rows[i].toCharArray()) {
                if (ch == '{') {
                    depth++;
                    opened = true;
                } else if (ch == '}') {
                    depth--;
                }
            }
            if (opened && depth <= 0) {
                return out.toString().stripTrailing();
            }
            if (i - start > 400) {
                break;
            }
        }
        return null;
    }

    /** 包裹骨架：把新增逻辑放进 if 分支、旧逻辑放进 else 分支（缩进 +4）。 */
    static String buildWrappedSnippet(String flagKey, List<HunkLine> lines) {
        List<String> added = new ArrayList<>();
        List<String> removed = new ArrayList<>();
        for (HunkLine line : lines) {
            if (line.isAdded()) {
                added.add(line.text());
            } else if (line.isRemoved()) {
                removed.add(line.text());
            }
        }
        if (added.isEmpty()) {
            return "// 没有新增逻辑，无需包裹";
        }
        StringBuilder out = new StringBuilder();
        out.append("if (featureFlags.isEnabled(\"").append(flagKey).append("\")) {\n");
        for (String line : added) {
            out.append("    ").append(line).append('\n');
        }
        out.append("} else {\n");
        if (removed.isEmpty()) {
            out.append("    // 旧路径：这里保留改动前的原语句\n");
        } else {
            for (String line : removed) {
                out.append("    ").append(line).append('\n');
            }
        }
        out.append("}\n");
        return out.toString();
    }

    private String patchTargetSummary(Patch patch) {
        return "文件 " + patch.filePath() + " 的新增逻辑（见下面「新增」块）";
    }

    private String readCurrent(long userId, Patch patch, String file) {
        try {
            ChatSession session = sessionRepository.findOwned(patch.sessionId(), userId)
                    .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "会话不存在或无权访问"));
            Workspace workspace = workspaceService.require(userId, session.workspaceId());
            return fileService.readFullText(workspace, file, READ_LIMIT);
        } catch (RuntimeException ex) {
            log.debug("读取 {} 的改动前内容失败: {}", file, ex.getMessage());
            return null;
        }
    }

    private Patch requireOwned(long userId, UUID patchId) {
        return patchRepository.findOwned(patchId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "补丁不存在或无权访问"));
    }
}
