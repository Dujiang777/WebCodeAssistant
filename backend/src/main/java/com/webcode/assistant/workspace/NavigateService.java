package com.webcode.assistant.workspace;

import com.webcode.assistant.agent.GrepService;
import com.webcode.assistant.agent.GrepResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 符号导航：跳转定义 / 查找引用。
 *
 * <p><b>为什么不是 JDT LS</b>：全量语言服务要拉 50MB 的 Eclipse JDT LS 内核、
 * 起子进程、再架一层 WebSocket 桥到 Monaco —— 对「读懂一个大仓库」帮助很大，
 * 但对「在中小工作区里点一下跳到声明处」是杀鸡用牛刀，而且部署面多了一大块。
 * 这里用一套刻意简单的 Java 启发式：声明模式的正则优先级匹配 +
 * 词边界引用搜索。中小仓库上又快又准，代价是极端重构场景可能漏判 ——
 * 那时用户还有语义检索和 grep，工具箱没有单点依赖。
 *
 * <p>匹配优先级（第一个命中即定义）：
 * <ol>
 *   <li>类型声明：{@code class/interface/enum/record SYM}</li>
 *   <li>方法声明：行内 {@code SYM(}，且 SYM 前不是 {@code .}（排除方法调用）、
 *       不是 {@code new }（排除构造调用）；</li>
 *   <li>字段声明：{@code SYM =} 或 {@code SYM ;}，且行内没有括号（排除赋值调用结果）。</li>
 * </ol>
 * 引用 = 全工作区词边界搜索（含定义行，前端标出来即可）。
 */
@Service
public class NavigateService {

    private static final Logger log = LoggerFactory.getLogger(NavigateService.class);

    /** 引用条数上限：导航面板不是检索报告，超过就让它去用 grep。 */
    private static final int MAX_REFERENCES = 60;

    private static final Pattern TYPE_DECL =
            Pattern.compile("\\b(class|interface|enum|record)\\s+%s\\b".formatted("%s"));

    private static final Set<String> KEYWORDS = Set.of(
            "if", "for", "while", "switch", "catch", "return", "new", "super", "this",
            "throw", "assert", "synchronized", "do", "else", "try", "finally", "instanceof");

    private final WorkspaceFileService fileService;
    private final GrepService grepService;

    public NavigateService(WorkspaceFileService fileService, GrepService grepService) {
        this.fileService = fileService;
        this.grepService = grepService;
    }

    /** 定义位置。 */
    public record Location(String file, int line, String text) {
    }

    /** 导航结果。{@code definition} 可为 null（找不到定义，如实返回）。 */
    public record NavigateResult(String symbol, Location definition, List<Location> references) {
    }

    public NavigateResult navigate(Workspace workspace, String path, int line, int column) {
        String symbol = wordAt(workspace, path, line, column);
        if (symbol == null || KEYWORDS.contains(symbol.toLowerCase(Locale.ROOT))) {
            return new NavigateResult(symbol == null ? "" : symbol, null, List.of());
        }
        Location definition = findDefinition(workspace, symbol);
        return new NavigateResult(symbol, definition, findReferences(workspace, symbol));
    }

    // ------------------------------------------------------------- 符号提取

    /**
     * 取光标处的标识符。{@code line}/{@code column} 都是 1-based（与 Monaco 一致）。
     * 光标不在标识符上时返回 null —— 前端提示「光标放到符号上再按」。
     */
    private String wordAt(Workspace workspace, String path, int line, int column) {
        FileContent content = fileService.read(workspace, path);
        if (content.binary() || content.content() == null) {
            return null;
        }
        String[] lines = content.content().split("\\r?\\n", -1);
        if (line < 1 || line > lines.length) {
            return null;
        }
        String text = lines[line - 1];
        int col = Math.min(Math.max(column, 1), text.length() + 1) - 1;
        if (col >= text.length() || !isIdentChar(text.charAt(col))) {
            // 光标落在标识符右边缘（比如符号后紧跟括号）时向左退一格再试
            if (col > 0 && isIdentChar(text.charAt(col - 1))) {
                col--;
            } else {
                return null;
            }
        }
        int start = col;
        while (start > 0 && isIdentChar(text.charAt(start - 1))) {
            start--;
        }
        int end = col;
        while (end < text.length() && isIdentChar(text.charAt(end))) {
            end++;
        }
        return text.substring(start, end);
    }

    private static boolean isIdentChar(char c) {
        return Character.isLetterOrDigit(c) || c == '_' || c == '$';
    }

    // ------------------------------------------------------------- 定义匹配

    private Location findDefinition(Workspace workspace, String symbol) {
        // 1. 类型声明
        List<GrepResult.GrepMatch> matches =
                grepService.search(workspace, "\\b(class|interface|enum|record)\\s+" + symbol + "\\b",
                        null, "*.java").matches();
        if (!matches.isEmpty()) {
            return toLocation(matches.get(0));
        }

        // 2. 方法声明：SYM( 出现、前面不是点/new、行长得像声明
        matches = grepService.search(workspace, "(^|[^.\\w])" + symbol + "\\s*\\(", null, "*.java").matches();
        Location method = null;
        for (GrepResult.GrepMatch match : matches) {
            if (looksLikeMethodDecl(match.text(), symbol)) {
                method = toLocation(match);
                break;
            }
        }
        if (method != null) {
            return method;
        }

        // 3. 字段声明：SYM = 或 SYM; 且行里没有括号
        matches = grepService.search(workspace, "(^|[^.\\w])" + symbol + "\\s*(=|;)", null, "*.java").matches();
        for (GrepResult.GrepMatch match : matches) {
            String text = match.text();
            if (!text.contains("(") && looksLikeFieldDecl(text, symbol)) {
                return toLocation(match);
            }
        }
        return null;
    }

    /** 行内 {@code SYM(} 是否像方法声明：有修饰符/返回类型、不是 return/throw 场景。 */
    private static boolean looksLikeMethodDecl(String line, String symbol) {
        int idx = line.indexOf(symbol);
        if (idx <= 0) {
            return false;
        }
        String before = line.substring(0, idx).trim();
        if (before.isEmpty() || before.endsWith(".")) {
            return false;
        }
        String trimmed = line.trim();
        if (trimmed.startsWith("return ") || trimmed.startsWith("throw ")
                || trimmed.startsWith("//") || trimmed.startsWith("*")) {
            return false;
        }
        // before 应该是「修饰符和/或返回类型」：最后一个词是类型或修饰符，而不是别的调用链
        String[] tokens = before.split("[\\s<>,\\[\\]]+");
        String last = tokens.length == 0 ? "" : tokens[tokens.length - 1];
        if (last.isEmpty()) {
            return false;
        }
        return Character.isJavaIdentifierStart(last.charAt(0)) && !KEYWORDS.contains(last)
                || last.equals("@Override");
    }

    private static boolean looksLikeFieldDecl(String line, String symbol) {
        String trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("return ")) {
            return false;
        }
        int idx = trimmed.indexOf(symbol);
        if (idx <= 0) {
            return false;
        }
        String before = trimmed.substring(0, idx).trim();
        String[] tokens = before.split("[\\s<>\\[\\]]+");
        String last = tokens.length == 0 ? "" : tokens[tokens.length - 1];
        return !last.isEmpty() && Character.isJavaIdentifierStart(last.charAt(0)) && !KEYWORDS.contains(last);
    }

    // ------------------------------------------------------------- 引用

    private List<Location> findReferences(Workspace workspace, String symbol) {
        GrepResult result = grepService.search(workspace, "\\b" + symbol + "\\b", null, null);
        List<Location> references = new ArrayList<>();
        for (GrepResult.GrepMatch match : result.matches()) {
            references.add(toLocation(match));
            if (references.size() >= MAX_REFERENCES) {
                break;
            }
        }
        return references;
    }

    private static Location toLocation(GrepResult.GrepMatch match) {
        String text = match.text();
        return new Location(match.file(), match.line(),
                text.length() > 200 ? text.substring(0, 200) : text);
    }
}
