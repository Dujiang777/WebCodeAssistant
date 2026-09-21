package com.webcode.assistant.context;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 引用校验器 —— 「Cite-or-refuse」里「refuse」那一半的落地。
 *
 * <p>光在 system prompt 里写「必须带引用」是不够的：模型仍然可以编一个格式正确、
 * 但指向不存在文件的引用，而用户不会去逐个点开核对。所以这里在回答落库之前
 * 扫一遍引用，把「文件不存在」「行号超出范围」的挑出来，前端标红。
 *
 * <p>三个刻意的设计：
 * <ul>
 *   <li><b>先屏蔽 URL 再扫描</b>。否则 {@code https://repo.maven.apache.org/.../x.pom}
 *       会被当成一个仓库内路径，凭空产生一堆「文件不存在」的假警报；</li>
 *   <li><b>不删除、不重写回答</b>。只做标注，正文永远原样展示 —— 助手说了什么就是什么，
 *       我们去改它的措辞反而会掩盖事实；</li>
 *   <li><b>校验失败不影响本轮回答</b>。这是质量信号，不是错误。</li>
 * </ul>
 */
@Component
public class CitationVerifier {

    private static final Logger log = LoggerFactory.getLogger(CitationVerifier.class);

    /** 一次回答里最多校验这么多条，防止模型输出上千条引用拖慢回合结束。 */
    private static final int MAX_CITATIONS = 120;

    /** 为校验行号而读取的文件体积上限。 */
    private static final long MAX_BYTES_FOR_LINE_CHECK = 4L * 1024 * 1024;

    private static final String EXTENSIONS =
            "java|kt|kts|scala|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|php|cs|c|h|cpp|hpp|swift"
                    + "|xml|yml|yaml|json|toml|properties|gradle|sql|sh|bat|ps1|md|txt|html|css|scss|vue|svelte";

    /** `路径/文件.ext` 可选跟 `:行号` 或 `:起始-结束`。 */
    private static final Pattern CITATION = Pattern.compile(
            "([\\w][\\w./\\\\\\-]*\\.(?:" + EXTENSIONS + "))(?!\\w)(?::(\\d{1,7})(?:\\s*[-–—]\\s*(\\d{1,7}))?)?");

    /** 把 URL 替换成等长空格，保证后续匹配不会跨过它。 */
    private static final Pattern URL = Pattern.compile("\\bhttps?://\\S+");

    private final WorkspaceFileService fileService;
    private final WorkspacePathResolver pathResolver;

    public CitationVerifier(WorkspaceFileService fileService, WorkspacePathResolver pathResolver) {
        this.fileService = fileService;
        this.pathResolver = pathResolver;
    }

    /**
     * 扫描并校验回答文本里的引用。
     *
     * @return 去重后的引用列表；没有任何引用时返回空列表（这本身就是个信号）
     */
    public List<Citation> verify(Workspace workspace, String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        String masked = URL.matcher(text).replaceAll(match -> " ".repeat(match.group().length()));

        Path root;
        try {
            root = fileService.rootOf(workspace);
        } catch (RuntimeException ex) {
            log.debug("解析工作区根目录失败，跳过引用校验: {}", ex.getMessage());
            return List.of();
        }

        Map<String, Integer> lineCountCache = new HashMap<>();
        Set<String> seen = new LinkedHashSet<>();
        List<Citation> citations = new ArrayList<>();

        Matcher matcher = CITATION.matcher(masked);
        while (matcher.find() && citations.size() < MAX_CITATIONS) {
            String rawFile = matcher.group(1).replace('\\', '/');
            while (rawFile.startsWith("./")) {
                rawFile = rawFile.substring(2);
            }
            Integer line = parse(matcher.group(2));
            Integer endLine = parse(matcher.group(3));
            String key = rawFile + ':' + line + '-' + endLine;
            if (!seen.add(key)) {
                continue;
            }
            citations.add(check(workspace, root, rawFile, line, endLine, lineCountCache));
        }
        return citations;
    }

    private Citation check(Workspace workspace, Path root, String file,
                           Integer line, Integer endLine, Map<String, Integer> lineCountCache) {
        Path target;
        try {
            target = pathResolver.resolve(root, file);
        } catch (ApiException ex) {
            return new Citation(file, line, endLine, false, "路径越出工作区范围");
        }
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return new Citation(file, line, endLine, false, "工作区里没有这个文件");
        }
        if (line == null) {
            return new Citation(file, line, endLine, true, null);
        }

        Integer total = lineCountCache.computeIfAbsent(file, key -> countLines(workspace, key));
        if (total == null) {
            // 读不出来（太大/二进制）就不做行号判断，避免误报
            return new Citation(file, line, endLine, true, null);
        }
        int requested = Math.max(line, endLine == null ? line : endLine);
        if (requested > total) {
            return new Citation(file, line, endLine, false,
                    "行号超出范围（该文件只有 " + total + " 行）");
        }
        return new Citation(file, line, endLine, true, null);
    }

    /** 行数未知时返回 null（不报错）。 */
    private Integer countLines(Workspace workspace, String file) {
        try {
            String content = fileService.readFullText(workspace, file, MAX_BYTES_FOR_LINE_CHECK);
            if (content == null) {
                return null;
            }
            if (content.isEmpty()) {
                return 0;
            }
            int lines = 1;
            for (int i = 0; i < content.length(); i++) {
                if (content.charAt(i) == '\n') {
                    lines++;
                }
            }
            // 以换行结尾时最后多算了一行空行
            return content.endsWith("\n") ? lines - 1 : lines;
        } catch (RuntimeException ex) {
            log.debug("统计行数失败 {}: {}", file, ex.getMessage());
            return null;
        }
    }

    private static Integer parse(String value) {
        if (value == null) {
            return null;
        }
        try {
            return Integer.valueOf(value);
        } catch (NumberFormatException ex) {
            return null;
        }
    }
}
