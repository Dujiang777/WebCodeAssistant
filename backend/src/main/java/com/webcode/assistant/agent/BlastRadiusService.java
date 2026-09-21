package com.webcode.assistant.agent;

import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.diff.FilePatch;
import com.webcode.assistant.workspace.diff.Hunk;
import com.webcode.assistant.workspace.diff.HunkLine;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 计算补丁影响面。
 *
 * <p>回答四个问题（正是用户点「应用」前真正关心的）：
 * <ol>
 *   <li><b>改了哪些成员</b> —— 从 diff 的增删行里抽方法/字段名；</li>
 *   <li><b>谁在调用</b> —— grep 类型名（以及被改的方法名），得到引用位置列表；</li>
 *   <li><b>是否碰到高风险包</b> —— Controller / Security / 支付 / 迁移脚本 / 配置；</li>
 *   <li><b>有没有测试覆盖</b> —— 引用该类型的测试文件。</li>
 * </ol>
 *
 * <p>所有结论都是「有依据的提示」而不是判决：真正拦不拦得住，取决于用户自己看。
 * 所以这里从不返回「禁止应用」，只返回「命中了几项风险」。
 */
@Service
public class BlastRadiusService {

    private static final Logger log = LoggerFactory.getLogger(BlastRadiusService.class);

    private static final int MAX_CALLERS = 20;
    private static final int MAX_TESTS = 8;
    private static final int MAX_MEMBERS = 12;
    private static final long MAX_FILE_BYTES = 1024 * 1024;

    /** 方法声明：必须有访问修饰符，避免把调用点当成声明。 */
    private static final Pattern METHOD_DECL = Pattern.compile(
            "(?:public|private|protected)\\s+(?:(?:static|final|synchronized|abstract|default|native)\\s+)*"
                    + "[\\w<>\\[\\],.\\s?]+?\\s+(\\w+)\\s*\\(");

    /** 字段声明。 */
    private static final Pattern FIELD_DECL = Pattern.compile(
            "(?:public|private|protected)\\s+(?:(?:static|final|transient|volatile)\\s+)*"
                    + "[\\w<>\\[\\],.\\s?]+?\\s+(\\w+)\\s*(?:=|;)");

    private static final Pattern TYPE_DECL = Pattern.compile(
            "\\b(?:class|interface|record|enum)\\s+(\\w+)");

    private static final Set<String> NON_MEMBER_NAMES = Set.of(
            "if", "for", "while", "switch", "catch", "return", "new", "throw", "super", "this",
            "synchronized", "try", "do", "else", "case", "assert");

    /** 被广泛使用的通用方法名，grep 它们只会得到噪音。 */
    private static final Set<String> UNINTERESTING_METHODS = Set.of(
            "get", "set", "is", "toString", "equals", "hashCode", "main", "run", "call",
            "value", "values", "of", "builder");

    private final WorkspaceFileService fileService;
    private final GrepService grepService;

    public BlastRadiusService(WorkspaceFileService fileService, GrepService grepService) {
        this.fileService = fileService;
        this.grepService = grepService;
    }

    public BlastRadius compute(Workspace workspace, String file, String diffText) {
        List<FilePatch> parsed;
        try {
            parsed = UnifiedDiffParser.parse(diffText, file);
        } catch (RuntimeException ex) {
            log.debug("影响面分析：diff 解析失败 {}", ex.getMessage());
            return empty(file, "补丁无法解析，未能分析影响面");
        }
        if (parsed.isEmpty()) {
            return empty(file, "补丁为空，未能分析影响面");
        }
        FilePatch patch = parsed.get(0);

        List<String> added = new ArrayList<>();
        List<String> removed = new ArrayList<>();
        for (Hunk hunk : patch.hunks()) {
            for (HunkLine line : hunk.lines()) {
                if (line.type() == '+') {
                    added.add(line.text());
                } else if (line.type() == '-') {
                    removed.add(line.text());
                }
            }
        }
        boolean createsFile = patch.createsFile();
        boolean deletesFile = patch.deletesFile();

        String current = readOrEmpty(workspace, file);
        String declaredType = firstMatch(TYPE_DECL, current);
        if (declaredType == null) {
            declaredType = firstMatch(TYPE_DECL, String.join("\n", added));
        }

        // ---- 1. 改了哪些成员 -------------------------------------------------
        LinkedHashSet<String> members = new LinkedHashSet<>();
        LinkedHashSet<String> declaredMethods = new LinkedHashSet<>();
        collectMembers(added, members, declaredMethods);
        collectMembers(removed, members, declaredMethods);

        List<String> changedMembers = members.stream().limit(MAX_MEMBERS).toList();
        boolean constructorChanged = declaredType != null
                && (members.contains(declaredType) || members.contains(decapitalize(declaredType)));

        // ---- 2. 谁在调用 ----------------------------------------------------
        List<BlastRadius.Ref> callers = new ArrayList<>();
        List<BlastRadius.Ref> tests = new ArrayList<>();
        boolean truncated = false;

        if (declaredType != null && !declaredType.isBlank()) {
            // 方法名里挑一个最有信息量的去搜（通用名如 get/toString 会淹没在噪音里）
            String methodToTrace = declaredMethods.stream()
                    .filter(name -> name.length() > 3 && !UNINTERESTING_METHODS.contains(name))
                    .findFirst()
                    .orElse(null);

            GrepResult byType = safeSearch(workspace, "\\b" + Pattern.quote(declaredType) + "\\b");
            truncated |= byType.truncated();
            splitRefs(byType, file, "type", callers, tests);

            if (methodToTrace != null) {
                GrepResult byMethod = safeSearch(workspace, "\\b" + Pattern.quote(methodToTrace) + "\\b");
                truncated |= byMethod.truncated();
                List<BlastRadius.Ref> methodCallers = new ArrayList<>();
                List<BlastRadius.Ref> ignoredTests = new ArrayList<>();
                splitRefs(byMethod, file, "method", methodCallers, ignoredTests);
                for (BlastRadius.Ref ref : methodCallers) {
                    if (!containsRef(callers, ref)) {
                        callers.add(ref);
                    }
                }
            }
        }

        callers.sort((a, b) -> a.file().equals(b.file())
                ? Integer.compare(a.line(), b.line())
                : a.file().compareTo(b.file()));
        tests.sort((a, b) -> a.file().equals(b.file())
                ? Integer.compare(a.line(), b.line())
                : a.file().compareTo(b.file()));

        boolean callersTruncated = truncated || callers.size() > MAX_CALLERS;
        List<BlastRadius.Ref> callerView = callers.stream().limit(MAX_CALLERS).toList();
        List<BlastRadius.Ref> testView = tests.stream().limit(MAX_TESTS).toList();

        // ---- 3. 风险项 ------------------------------------------------------
        List<BlastRadius.Risk> risks = detectRisks(file, current, added, removed,
                declaredMethods, constructorChanged, createsFile, deletesFile,
                testView.isEmpty(), callerView.size());

        // ---- 4. 汇总 --------------------------------------------------------
        String riskLevel = overallLevel(risks, callers.size());
        String headline = buildHeadline(declaredType, added.size(), removed.size(),
                changedMembers.size(), callers.size(), tests.size(), risks, riskLevel);

        return new BlastRadius(file, declaredType, changedMembers, added.size(), removed.size(),
                callerView, testView, risks, riskLevel, headline, callersTruncated);
    }

    /** 供 Agent 工具使用的纯文本版影响面，随 propose_patch 的结果回给模型。 */
    public String describeForModel(BlastRadius radius) {
        StringBuilder sb = new StringBuilder();
        sb.append("影响面分析（供你判断是否需要在说明里提醒用户）：\n");
        sb.append("- 改动类型：").append(radius.declaredType() == null ? "（未识别）" : radius.declaredType())
                .append("；变更 +").append(radius.addedLines()).append(" / -").append(radius.removedLines())
                .append(" 行\n");
        if (!radius.changedMembers().isEmpty()) {
            sb.append("- 触碰成员：").append(String.join("、", radius.changedMembers())).append('\n');
        }
        sb.append("- 引用该类型的位置：").append(radius.callers().size()).append(" 处")
                .append(radius.callersTruncated() ? "（已截断）" : "").append('\n');
        for (BlastRadius.Ref ref : radius.callers()) {
            sb.append("    ").append(ref.file()).append(':').append(ref.line())
                    .append("  ").append(abbreviate(ref.text())).append('\n');
        }
        sb.append("- 测试覆盖：").append(radius.tests().isEmpty() ? "未找到引用该类型的测试"
                : radius.tests().size() + " 个测试文件引用").append('\n');
        for (BlastRadius.Ref ref : radius.tests()) {
            sb.append("    ").append(ref.file()).append(':').append(ref.line()).append('\n');
        }
        if (radius.risks().isEmpty()) {
            sb.append("- 风险：未命中预置的高风险特征\n");
        } else {
            sb.append("- 风险：\n");
            for (BlastRadius.Risk risk : radius.risks()) {
                sb.append("    [").append(risk.level()).append("] ").append(risk.label())
                        .append(" —— ").append(risk.reason()).append('\n');
            }
        }
        sb.append("\n如果命中高风险项，请在补丁说明里用一句话提醒用户影响面；"
                + "不要因此拒绝给出补丁，用户自己会决定是否应用。");
        return sb.toString();
    }

    // ------------------------------------------------------------ 内部实现

    private void collectMembers(List<String> lines, Set<String> members, Set<String> methods) {
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("*")
                    || trimmed.startsWith("/*")) {
                continue;
            }
            Matcher method = METHOD_DECL.matcher(trimmed);
            if (method.find()) {
                String name = method.group(1);
                if (!NON_MEMBER_NAMES.contains(name)) {
                    members.add(name);
                    methods.add(name);
                }
                continue;
            }
            Matcher field = FIELD_DECL.matcher(trimmed);
            if (field.find()) {
                String name = field.group(1);
                if (!NON_MEMBER_NAMES.contains(name)) {
                    members.add(name);
                }
            }
        }
    }

    /** 把 grep 结果拆成「测试引用」和「普通引用」，并排除被改文件自身。 */
    private void splitRefs(GrepResult result, String selfFile, String kind,
                           List<BlastRadius.Ref> callers, List<BlastRadius.Ref> tests) {
        for (GrepResult.GrepMatch match : result.matches()) {
            String path = match.file();
            if (path == null || path.equals(selfFile)) {
                continue;
            }
            BlastRadius.Ref ref = new BlastRadius.Ref(path, match.line(), match.text(),
                    isTestPath(path) ? "test" : kind);
            if ("test".equals(ref.kind())) {
                // 按**文件**去重：界面上这一行写的是「N 个测试文件覆盖」，
                // 同一个测试文件里匹配到 4 处不能算 4 个文件 —— 那会凭空夸大覆盖度。
                if (!containsFile(tests, path)) {
                    tests.add(ref);
                }
            } else if (!containsRef(callers, ref)) {
                callers.add(ref);
            }
        }
    }

    private static boolean containsFile(List<BlastRadius.Ref> refs, String file) {
        for (BlastRadius.Ref ref : refs) {
            if (ref.file().equals(file)) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsRef(List<BlastRadius.Ref> refs, BlastRadius.Ref candidate) {
        for (BlastRadius.Ref ref : refs) {
            if (ref.line() == candidate.line() && ref.file().equals(candidate.file())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isTestPath(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("/test/") || lower.contains("/tests/") || lower.contains("src\\test\\")) {
            return true;
        }
        String name = lower.substring(lower.lastIndexOf('/') + 1);
        return name.matches(".*(test|tests|it|spec)\\.(java|kt|scala)$");
    }

    private GrepResult safeSearch(Workspace workspace, String pattern) {
        try {
            return grepService.search(workspace, pattern, ".", null);
        } catch (RuntimeException ex) {
            log.debug("影响面分析：搜索 {} 失败 {}", pattern, ex.getMessage());
            return GrepResult.empty(pattern, "n/a", "搜索失败");
        }
    }

    private List<BlastRadius.Risk> detectRisks(String file, String content,
                                               List<String> added, List<String> removed,
                                               Set<String> declaredMethods,
                                               boolean constructorChanged,
                                               boolean createsFile, boolean deletesFile,
                                               boolean noTests, int callerCount) {
        List<BlastRadius.Risk> risks = new ArrayList<>();
        String lowerPath = file.toLowerCase(Locale.ROOT);
        String body = content == null ? "" : content;
        String addedText = String.join("\n", added);

        // 对外接口
        if (lowerPath.contains("controller") || body.contains("@RestController") || body.contains("@Controller")
                || addedText.contains("@RestController") || addedText.contains("@Controller")) {
            risks.add(new BlastRadius.Risk("对外 HTTP 接口", BlastRadius.LEVEL_HIGH,
                    "改动会直接影响接口的入参/返回或状态码，客户端可能受影响"));
        }
        // 鉴权与安全
        if (lowerPath.contains("security") || lowerPath.contains("auth") || lowerPath.contains("jwt")
                || lowerPath.contains("token") || lowerPath.contains("login") || lowerPath.contains("permission")
                || body.contains("@PreAuthorize") || body.contains("@Secured")
                || body.contains("SecurityFilterChain") || body.contains("PasswordEncoder")) {
            risks.add(new BlastRadius.Risk("鉴权 / 安全", BlastRadius.LEVEL_HIGH,
                    "这段代码参与身份校验或权限判定，出错会变成越权漏洞而不是普通的 bug"));
        }
        // 支付 / 资金
        if (lowerPath.matches(".*(pay|payment|billing|wallet|refund|settle|invoice|order).*")) {
            risks.add(new BlastRadius.Risk("支付 / 资金链路", BlastRadius.LEVEL_HIGH,
                    "涉及金额计算或交易状态，改动需要先算清楚边界条件与幂等性"));
        }
        // 持久化
        if (lowerPath.contains("repository") || lowerPath.contains("dao") || lowerPath.contains("mapper")
                || body.contains("@Entity") || body.contains("JpaRepository") || body.contains("@Table")) {
            risks.add(new BlastRadius.Risk("持久化 / 数据访问", BlastRadius.LEVEL_MEDIUM,
                    "可能影响查询语义或数据一致性，注意 N+1 与事务边界"));
        }
        // 数据库结构
        if (lowerPath.endsWith(".sql") || lowerPath.contains("migration") || lowerPath.contains("liquibase")
                || lowerPath.contains("flyway")) {
            risks.add(new BlastRadius.Risk("数据库结构变更", BlastRadius.LEVEL_HIGH,
                    "迁移脚本一旦执行就难以回滚，且会影响所有环境的存量数据"));
        }
        // 配置
        if (lowerPath.matches(".*application.*\\.(yml|yaml|properties)$") || lowerPath.contains("config")) {
            risks.add(new BlastRadius.Risk("应用配置", BlastRadius.LEVEL_MEDIUM,
                    "配置改动通常无法被编译器和测试覆盖，出错只在运行时暴露"));
        }
        if (body.contains("@Transactional") || addedText.contains("@Transactional")) {
            risks.add(new BlastRadius.Risk("事务边界", BlastRadius.LEVEL_MEDIUM,
                    "事务的传播行为与回滚条件容易被改坏，且很难在单测里发现"));
        }
        // 签名破坏性变更
        List<String> removedPublicMethods = new ArrayList<>(declaredMethods);
        for (String name : removedPublicMethods) {
            boolean wasPublic = removed.stream().anyMatch(line -> line.contains(name + "(")
                    && (line.contains("public") || line.contains("protected")));
            boolean stillThere = added.stream().anyMatch(line -> line.contains(name + "("));
            if (wasPublic && !stillThere) {
                risks.add(new BlastRadius.Risk("移除公开方法「" + name + "」", BlastRadius.LEVEL_HIGH,
                        "调用方会编译失败。这是破坏性变更，需要同步修改所有引用点"));
            }
        }
        if (constructorChanged) {
            risks.add(new BlastRadius.Risk("改动构造器签名", BlastRadius.LEVEL_MEDIUM,
                    "所有 new / 依赖注入点都需要同步调整，Spring 会在启动时报错"));
        }
        if (deletesFile) {
            risks.add(new BlastRadius.Risk("删除文件", BlastRadius.LEVEL_HIGH,
                    "文件删除后所有引用都会失效，且无法通过编译发现全部问题"));
        }
        if (createsFile) {
            risks.add(new BlastRadius.Risk("新建文件", BlastRadius.LEVEL_LOW,
                    "新文件不会影响既有调用方，但需要确认包名与命名规范"));
        }
        if (noTests && !createsFile) {
            risks.add(new BlastRadius.Risk("没有测试覆盖", BlastRadius.LEVEL_MEDIUM,
                    "工作区里没有引用该类型的测试。编译能过不代表行为没被改坏"));
        }
        if (callerCount >= 8) {
            risks.add(new BlastRadius.Risk("被 " + callerCount + " 处引用", BlastRadius.LEVEL_MEDIUM,
                    "影响面较广，建议应用后跑一次编译与相关测试"));
        }
        return risks;
    }

    private static String overallLevel(List<BlastRadius.Risk> risks, int callerCount) {
        boolean anyHigh = risks.stream().anyMatch(r -> BlastRadius.LEVEL_HIGH.equals(r.level()));
        if (anyHigh || callerCount >= 8) {
            return BlastRadius.LEVEL_HIGH;
        }
        boolean anyMedium = risks.stream().anyMatch(r -> BlastRadius.LEVEL_MEDIUM.equals(r.level()));
        if (anyMedium || callerCount > 0) {
            return BlastRadius.LEVEL_MEDIUM;
        }
        return BlastRadius.LEVEL_LOW;
    }

    private static String buildHeadline(String type, int added, int removed, int members,
                                        int callers, int tests, List<BlastRadius.Risk> risks, String level) {
        StringBuilder sb = new StringBuilder();
        sb.append(type == null ? "改动内容" : "改动 " + type);
        sb.append("：+").append(added).append(" / -").append(removed).append(" 行");
        if (members > 0) {
            sb.append("，").append(members).append(" 个成员");
        }
        sb.append("，").append(callers).append(" 处引用");
        if (tests > 0) {
            sb.append("，").append(tests).append(" 个测试文件覆盖");
        }
        long high = risks.stream().filter(r -> BlastRadius.LEVEL_HIGH.equals(r.level())).count();
        if (high > 0) {
            sb.append("，").append(high).append(" 项高风险");
        } else if (BlastRadius.LEVEL_LOW.equals(level)) {
            sb.append("，未发现高风险特征");
        }
        return sb.toString();
    }

    private String readOrEmpty(Workspace workspace, String file) {
        try {
            return fileService.readFullText(workspace, file, MAX_FILE_BYTES);
        } catch (RuntimeException ex) {
            return "";
        }
    }

    private static String firstMatch(Pattern pattern, String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String decapitalize(String value) {
        return value == null || value.isEmpty()
                ? value
                : Character.toLowerCase(value.charAt(0)) + value.substring(1);
    }

    private static String abbreviate(String text) {
        if (text == null) {
            return "";
        }
        String trimmed = text.trim();
        return trimmed.length() > 110 ? trimmed.substring(0, 110) + "…" : trimmed;
    }

    private static BlastRadius empty(String file, String reason) {
        return new BlastRadius(file, null, List.of(), 0, 0, List.of(), List.of(),
                List.of(new BlastRadius.Risk("无法分析", BlastRadius.LEVEL_LOW, reason)),
                BlastRadius.LEVEL_LOW, reason, false);
    }
}
