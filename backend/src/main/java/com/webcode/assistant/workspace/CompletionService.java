package com.webcode.assistant.workspace;

import com.webcode.assistant.agent.GrepResult;
import com.webcode.assistant.agent.GrepService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 跨文件补全：把工作区里的「符号定义」建一张轻量索引，供 Monaco 的建议面板用。
 *
 * <p><b>为什么不是 LSP completion</b>：类型推导式的补全只有真语言服务做得好，
 * 但中小工作区里「把本仓库已有的类名/方法名/函数名接上」是补全需求的九成。
 * 索引是正则提取的符号定义（与批 9 符号导航同一启发式家族），代价是补不了
 * 依赖 jar / node_modules 里的 API —— 那一层等每用户沙箱后再议。
 *
 * <p><b>缓存策略</b>：按工作区缓存符号表，TTL 15 秒。不做文件监听 —— 补全
 * 允许几秒陈旧，不该为它上 watcher。单次补全请求 O(符号数) 的前缀过滤，
 * 几千符号是微秒级。
 */
@Service
public class CompletionService {

    private static final Logger log = LoggerFactory.getLogger(CompletionService.class);

    /** 符号表缓存时长。补全允许短暂陈旧，不值得上文件监听。 */
    private static final long CACHE_TTL_MS = 15_000;

    /** 符号表上限：超大工作区截断，宁可少补不全库炸内存。 */
    private static final int MAX_SYMBOLS = 5000;

    /** 单次返回的候选上限：建议面板一屏能消化的量。 */
    private static final int MAX_CANDIDATES = 60;

    /**
     * 一个可补全的符号。
     *
     * <p>{@code kind}: class / function / method / field / variable。
     * {@code snippet} 是定义那一行的原文（已 trim、截断）—— 建议面板右侧会显示它，
     * 让用户在不跳转的情况下就能确认「是不是我要的那个」。
     */
    public record Symbol(String name, String kind, String file, int line, String snippet) {
    }

    private record CacheEntry(long builtAt, List<Symbol> symbols) {
    }

    private final GrepService grepService;
    private final Map<Long, CacheEntry> cache = new ConcurrentHashMap<>();

    /** 符号提取规则：一条正则 + 一种 kind。对 match 行二次 find() 提取组。 */
    private record Rule(Pattern pattern, String kind, String glob) {
    }

    private static final List<Rule> RULES = List.of(
            // 类型声明：Java / JS / TS / Python / Go / Rust / Kotlin 通吃
            new Rule(Pattern.compile("\\b(class|interface|enum|record|struct|trait)\\s+([A-Za-z_$][\\w$]*)"),
                    "class", null),
            // JS/TS 函数声明
            new Rule(Pattern.compile("\\bfunction\\s+([A-Za-z_$][\\w$]*)"), "function", null),
            // Python 函数
            new Rule(Pattern.compile("^\\s*def\\s+([A-Za-z_][\\w]*)"), "function", "*.py"),
            // Java/Scala 方法签名：修饰符开头、有返回类型、名字后紧跟 (
            new Rule(Pattern.compile("^\\s*(?:public|private|protected)[\\w\\s<>,.\\[\\]*?]*?"
                            + "\\s([A-Za-z_$][\\w$]*)\\s*\\("),
                    "method", "*.java"),
            // JS/TS 变量（含导出）
            new Rule(Pattern.compile("^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)"),
                    "variable", null),
            // Java 字段：修饰符 + 类型 + 名字 = 或 ;
            new Rule(Pattern.compile("^\\s*(?:public|private|protected)\\s+(?:static\\s+)?(?:final\\s+)?"
                            + "[\\w<>,.\\[\\]]+\\s+([A-Za-z_$][\\w$]*)\\s*[=;]"),
                    "field", "*.java"));

    /** 这些「符号」其实是语言关键字，误提取了要滤掉。 */
    private static final Set<String> KEYWORDS = Set.of(
            "if", "for", "while", "switch", "catch", "return", "new", "this", "super",
            "throw", "class", "function", "const", "let", "var", "def", "true", "false", "null");

    public CompletionService(GrepService grepService) {
        this.grepService = grepService;
    }

    /**
     * 按前缀补全，结果按相关性排序。
     *
     * <p>排序权重（2026-09-30 加）：先看这个符号离用户多远 —— 同文件 &gt; 同目录 &gt; 其他；
     * 再看它的性质 —— 类型 &gt; 可调用 &gt; 字段/变量；最后才比名字长短。
     * 之前只按「索引扫描顺序」排，用户敲 `us` 时同文件的 UserService 可能排在
     * 某个遥远目录的 userAudit 后面 —— 那等于没有排序。前缀命中一律优先于子串命中。
     */
    public List<Symbol> complete(Workspace workspace, String prefix, String currentFile) {
        List<Symbol> symbols = symbolTable(workspace);
        if (symbols.isEmpty()) {
            return List.of();
        }
        String lower = prefix == null ? "" : prefix.trim().toLowerCase(Locale.ROOT);
        List<Symbol> starts = new ArrayList<>();
        List<Symbol> contains = new ArrayList<>();
        for (Symbol symbol : symbols) {
            String name = symbol.name().toLowerCase(Locale.ROOT);
            if (lower.isEmpty() || name.startsWith(lower)) {
                starts.add(symbol);
            } else if (name.contains(lower)) {
                contains.add(symbol);
            }
        }
        Comparator<Symbol> order = relevance(currentFile);
        starts.sort(order);
        contains.sort(order);
        List<Symbol> result = new ArrayList<>(starts.subList(0, Math.min(MAX_CANDIDATES, starts.size())));
        for (Symbol symbol : contains) {
            if (result.size() >= MAX_CANDIDATES) {
                break;
            }
            result.add(symbol);
        }
        return result;
    }

    /** 相关性排序：同文件 &gt; 同目录 &gt; 其他；同层内类型 &gt; 可调用 &gt; 字段；再比名字。 */
    private static Comparator<Symbol> relevance(String currentFile) {
        String file = currentFile == null ? "" : currentFile.replace('\\', '/');
        String dir = file.contains("/") ? file.substring(0, file.lastIndexOf('/')) : "";
        return Comparator
                .comparingInt((Symbol symbol) -> locality(symbol, file, dir))
                .thenComparingInt(symbol -> kindWeight(symbol.kind()))
                .thenComparingInt(symbol -> symbol.name().length())
                .thenComparing(Symbol::name);
    }

    /** 离当前编辑位置的距离：0 = 同一个文件，1 = 同一个目录，2 = 别处。 */
    private static int locality(Symbol symbol, String file, String dir) {
        String target = symbol.file() == null ? "" : symbol.file().replace('\\', '/');
        if (!file.isEmpty() && target.equals(file)) {
            return 0;
        }
        if (!dir.isEmpty() && target.startsWith(dir + "/")) {
            return 1;
        }
        return 2;
    }

    /** 类型先于可调用，可调用先于字段 —— 补全面板的第一屏应该是最常用的东西。 */
    private static int kindWeight(String kind) {
        return switch (kind == null ? "" : kind) {
            case "class" -> 0;
            case "method", "function" -> 1;
            default -> 2;
        };
    }

    /** 定义行原文：压掉缩进并截断（建议面板一行能显示的极限）。 */
    private static String snippetOf(String line) {
        if (line == null) {
            return "";
        }
        String text = line.strip();
        return text.length() > 120 ? text.substring(0, 120) + "…" : text;
    }

    /** 符号表（带 TTL 缓存）。 */
    private List<Symbol> symbolTable(Workspace workspace) {
        long now = System.currentTimeMillis();
        CacheEntry entry = cache.get(workspace.id());
        if (entry != null && now - entry.builtAt() < CACHE_TTL_MS) {
            return entry.symbols();
        }
        List<Symbol> symbols = build(workspace);
        cache.put(workspace.id(), new CacheEntry(now, symbols));
        log.debug("符号表重建 workspace={} symbols={}", workspace.id(), symbols.size());
        return symbols;
    }

    /** 全工作区跑一遍提取规则，合并去重。 */
    private List<Symbol> build(Workspace workspace) {
        // LinkedHashMap 保序去重：同一个名字的同一处定义只留一条
        Map<String, Symbol> unique = new LinkedHashMap<>();
        Set<String> seenFiles = new HashSet<>();
        for (Rule rule : RULES) {
            GrepResult result;
            try {
                result = grepService.search(workspace, rule.pattern().pattern(), null, rule.glob());
            } catch (Exception ex) {
                // 正则被当成非法 grep 模式之类的意外，跳过该规则不让整张表挂掉
                continue;
            }
            for (GrepResult.GrepMatch match : result.matches()) {
                String name = extractName(rule.pattern(), match.text());
                if (name == null || name.length() < 2 || KEYWORDS.contains(name)) {
                    continue;
                }
                String key = name + "|" + rule.kind() + "|" + match.file() + ":" + match.line();
                if (unique.containsKey(key)) {
                    continue;
                }
                unique.put(key, new Symbol(name, rule.kind(), match.file(), match.line(),
                        snippetOf(match.text())));
                seenFiles.add(match.file());
                if (unique.size() >= MAX_SYMBOLS) {
                    return new ArrayList<>(unique.values());
                }
            }
        }
        log.debug("补全符号表 workspace={} symbols={} files={}", workspace.id(), unique.size(), seenFiles.size());
        return new ArrayList<>(unique.values());
    }

    /** 从匹配行提取符号名（第一个捕获组）。 */
    private static String extractName(Pattern pattern, String line) {
        Matcher matcher = pattern.matcher(line);
        if (!matcher.find()) {
            return null;
        }
        // 类型声明有两个组，取最后一个（符号名）；其余规则只有一个组
        int group = matcher.groupCount() >= 2 ? 2 : 1;
        return matcher.group(group);
    }
}
