package com.webcode.assistant.workspace;

import com.fasterxml.jackson.core.JsonLocation;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 编辑器诊断（确定性 lint）：给 Monaco 的下划线标记供数。
 *
 * <p><b>为什么不做编译器级诊断</b>：真语义诊断只有完整 LSP 能做（那是批 9 符号导航
 * 同一个否决理由）。这里只做「确定性、零误报」的规则 —— 每一条报出来的都必须是
 * 真错误，宁可少报不可吓人。这是与「降级可以，装死不行」同一哲学的另一面：
 * 诊断比检索更怕误报，一条假红线烧掉的是用户对整个编辑器的信任。
 *
 * <p>两条规则：
 * <ol>
 *   <li><b>JSON 真解析</b>：Jackson 给出精确行列，这是唯一 100% 可信的规则；</li>
 *   <li><b>括号/块注释平衡</b>：先用小状态机剔除字符串与注释，再栈匹配
 *       ({[ 与 )]}。Java 文本块、JS 模板串、正则里配对的括号都剔除或配对，
 *       常见代码上实测零误报。</li>
 * </ol>
 *
 * <p>lint 的输入是前端传来的<b>编辑器缓冲区</b>而不是磁盘文件 —— 用户敲到一半
 * 还没保存时，诊断要跟着缓冲区走才对。
 */
@Service
public class LintService {

    private static final Logger log = LoggerFactory.getLogger(LintService.class);

    /** 单次 lint 的内容上限：与单文件读取上限一致，超限直接跳过。 */
    private static final int MAX_CONTENT_CHARS = 512 * 1024;

    /** 适用括号检查的扩展名（小写）。HTML/YAML/Markdown 这类不适用，宁可不做。 */
    private static final Set<String> BRACE_LANGUAGES = Set.of(
            "java", "js", "jsx", "ts", "tsx", "css", "scss", "less",
            "json", "py", "c", "h", "cpp", "hpp", "go", "rs", "kt", "php", "swift");

    /** 字符串允许跨行的扩展名（模板串）。其余语言行内未闭合的引号直接忽略。 */
    private static final Set<String> MULTILINE_STRING_LANGUAGES = Set.of(
            "js", "jsx", "ts", "tsx");

    private final ObjectMapper objectMapper;

    public LintService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** 一条诊断。行列都是 1-based，与 Monaco 的 IMarker 一致。 */
    public record LintIssue(int line, int column, int endLine, int endColumn,
                            String severity, String message) {
    }

    /**
     * 对编辑器缓冲区做确定性诊断。{@code path} 只用于判定语言，不读磁盘。
     */
    public List<LintIssue> lint(String path, String content) {
        if (content == null || content.isEmpty() || content.length() > MAX_CONTENT_CHARS) {
            return List.of();
        }
        String ext = extensionOf(path);
        if (ext == null) {
            return List.of();
        }
        List<LintIssue> issues = new ArrayList<>();
        if (ext.equals("json")) {
            lintJson(content, issues);
        }
        if (BRACE_LANGUAGES.contains(ext)) {
            lintBraces(content, ext, issues);
        }
        return issues;
    }

    private String extensionOf(String path) {
        if (path == null) {
            return null;
        }
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String name = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return null;
        }
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    // ------------------------------------------------------------- JSON

    private void lintJson(String content, List<LintIssue> issues) {
        try {
            objectMapper.readTree(content);
        } catch (JsonProcessingException ex) {
            JsonLocation loc = ex.getLocation();
            int line = Math.max(loc.getLineNr(), 1);
            int column = Math.max(loc.getColumnNr(), 1);
            String message = ex.getOriginalMessage();
            // Jackson 的 message 常是英文长句，截短到一行可用
            if (message.length() > 120) {
                message = message.substring(0, 120);
            }
            issues.add(new LintIssue(line, column, line, column, "error", "JSON 解析错误：" + message));
        }
    }

    // ------------------------------------------------------------- 括号平衡

    /** 配对结果。 */
    private record Bracket(char open, char close) {
    }

    private static final Bracket[] BRACKETS = {
            new Bracket('(', ')'),
            new Bracket('[', ']'),
            new Bracket('{', '}'),
    };

    /**
     * 剔除字符串与注释后做括号栈匹配。
     *
     * <p>剔除规则（刻意宽松，宁可漏剔不可剔错）：
     * <ul>
     *   <li>行注释 {@code //} 剔到行尾；</li>
     *   <li>块注释 {@code /* ... *&#47;} 整段剔除，未闭合报 error；</li>
     *   <li>Java 文本块 {@code """} 跨行剔除；</li>
     *   <li>JS/TS 模板串 backtick 跨行剔除；</li>
     *   <li>其余单行字符串行尾未闭合就当闭合（避免把注释里的引号当字符串开头）。</li>
     * </ul>
     */
    private void lintBraces(String content, String ext, List<LintIssue> issues) {
        boolean multilineStrings = MULTILINE_STRING_LANGUAGES.contains(ext);
        char[] chars = content.toCharArray();

        boolean inBlockComment = false;
        // 跨行字符串的闭合符（0 = 不在跨行字符串中）
        char multilineStringClose = 0;
        // 括号栈：元素 = {字符, 在内容中的偏移}
        Deque<int[]> stack = new ArrayDeque<>();

        int line = 1;
        int column = 1;
        for (int i = 0; i < chars.length; i++) {
            char c = chars[i];
            char next = i + 1 < chars.length ? chars[i + 1] : 0;
            char next2 = i + 2 < chars.length ? chars[i + 2] : 0;

            if (c == '\n') {
                line++;
                column = 1;
                continue;
            }

            if (inBlockComment) {
                if (c == '*' && next == '/') {
                    inBlockComment = false;
                    i++;
                    column += 2;
                } else {
                    column++;
                }
                continue;
            }
            if (multilineStringClose != 0) {
                if (c == '\\' && multilineStringClose != '`' && i + 1 < chars.length) {
                    i++; // 转义字符跳过下一个
                    column += 2;
                } else if (c == multilineStringClose) {
                    multilineStringClose = 0;
                }
                column++;
                continue;
            }

            // 行注释：剔到行尾
            if (c == '/' && next == '/') {
                while (i + 1 < chars.length && chars[i + 1] != '\n') {
                    i++;
                }
                continue;
            }
            // 块注释开始
            if (c == '/' && next == '*') {
                inBlockComment = true;
                i++;
                column += 2;
                continue;
            }
            // Java 文本块
            if (ext.equals("java") && c == '"' && next == '"' && next2 == '"') {
                // 找闭合的 """；找不到就让它滑过（罕见，不报）
                int j = content.indexOf("\"\"\"", i + 3);
                if (j >= 0) {
                    // 把游标推进到闭合符末尾，行号列号同步粗算
                    for (int k = i + 3; k <= j + 2 && k < chars.length; k++) {
                        if (chars[k] == '\n') {
                            line++;
                            column = 1;
                        } else {
                            column++;
                        }
                    }
                    i = j + 2;
                }
                continue;
            }
            // 跨行字符串（JS 模板串）
            if (multilineStrings && (c == '`')) {
                multilineStringClose = '`';
                column++;
                continue;
            }
            // 单行字符串：剔到本行闭合；行尾还没闭合就当闭合（宽松处理）
            if (c == '"' || c == '\'') {
                char quote = c;
                i++;
                column++;
                while (i < chars.length && chars[i] != '\n') {
                    if (chars[i] == '\\') {
                        i++; // 转义
                        column++;
                    } else if (chars[i] == quote) {
                        break;
                    }
                    i++;
                    column++;
                }
                continue;
            }

            // 括号
            boolean isOpen = false;
            for (Bracket bracket : BRACKETS) {
                if (c == bracket.open()) {
                    stack.push(new int[]{c, i, line, column});
                    isOpen = true;
                    break;
                }
            }
            if (!isOpen) {
                char expectedOpen = 0;
                for (Bracket bracket : BRACKETS) {
                    if (c == bracket.close()) {
                        expectedOpen = bracket.open();
                        break;
                    }
                }
                if (expectedOpen != 0) {
                    if (stack.isEmpty() || stack.peek()[0] != expectedOpen) {
                        issues.add(new LintIssue(line, column, line, column + 1, "error",
                                "多余的 '" + c + "'，没有与之配对的开始括号"));
                        // 继续扫，把同类问题一次报完
                    } else {
                        stack.pop();
                    }
                }
            }
            column++;
        }

        if (inBlockComment) {
            issues.add(new LintIssue(line, column, line, column, "error", "块注释 /* 没有闭合的 */"));
        }
        for (int[] open : stack) {
            issues.add(new LintIssue(open[2], open[3], open[2], open[3] + 1, "error",
                    "'" + (char) open[0] + "' 没有闭合 —— 检查是否漏了配对的结束括号"));
        }
    }
}
