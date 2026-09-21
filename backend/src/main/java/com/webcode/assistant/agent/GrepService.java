package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.workspace.IgnoreRules;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import java.util.stream.Stream;

/**
 * 工作区内的代码搜索。
 *
 * <p>优先调用 {@code ripgrep}（有则用）：它默认遵守 .gitignore、会自动跳过二进制文件，
 * 速度也远好于纯 Java 遍历。没有安装 ripgrep 时退回 Java 正则实现，
 * 用同一套 {@link IgnoreRules} 保证两种引擎的可见文件集一致。
 *
 * <p>结果条数上限由 {@code app.grep-max-results} 控制 —— 工具结果会全量回灌进模型上下文，
 * 不设上限的话一次搜索就能把 token 预算烧光。
 */
@Service
public class GrepService {

    private static final Logger log = LoggerFactory.getLogger(GrepService.class);
    private static final int MAX_PATTERN_LENGTH = 500;
    private static final int MAX_LINE_LENGTH = 400;
    private static final long RIPGREP_TIMEOUT_SECONDS = 20;
    private static final long JAVA_SCAN_TIMEOUT_MILLIS = 15_000;
    private static final long MAX_SCANNED_FILE_BYTES = 2L * 1024 * 1024;
    private static final int MAX_SCANNED_FILES = 20000;

    private final WorkspacePathResolver pathResolver;
    private final AppProperties properties;

    /** 探测到的 ripgrep 可执行文件；为 null 表示不可用。 */
    private final String ripgrepBinary;

    public GrepService(WorkspacePathResolver pathResolver, AppProperties properties) {
        this.pathResolver = pathResolver;
        this.properties = properties;
        this.ripgrepBinary = locateRipgrep();
        if (ripgrepBinary != null) {
            log.info("grep 引擎: ripgrep ({})", ripgrepBinary);
        } else {
            log.info("grep 引擎: Java 正则（未检测到 ripgrep，功能不受影响，大仓库下速度略慢）");
        }
    }

    public GrepResult search(Workspace workspace, String pattern, String subPath, String glob) {
        Pattern compiled = compile(pattern);
        Path root = pathResolver.rootOf(workspace.rootPath());
        Path searchRoot = pathResolver.resolve(root, subPath);
        if (!Files.exists(searchRoot, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "搜索路径不存在: " + subPath);
        }

        if (ripgrepBinary != null) {
            GrepResult result = searchWithRipgrep(root, searchRoot, pattern, glob);
            if (result != null) {
                return result;
            }
            log.debug("ripgrep 执行失败，回退到 Java 实现");
        }
        return searchWithJava(root, searchRoot, pattern, compiled);
    }

    public String engineName() {
        return ripgrepBinary != null ? "ripgrep" : "java";
    }

    // ------------------------------------------------------------- ripgrep

    private GrepResult searchWithRipgrep(Path root, Path searchRoot, String pattern, String glob) {
        int limit = properties.grepMaxResults();
        List<String> command = new ArrayList<>(List.of(
                ripgrepBinary,
                "--line-number",
                "--no-heading",
                "--color=never",
                "--with-filename",
                "--max-columns", String.valueOf(MAX_LINE_LENGTH),
                "--max-count", String.valueOf(limit),   // 单文件上限，整体上限靠读到 limit+1 条后主动结束进程
                "-e", pattern));
        for (String ignored : IgnoreRules.ignoredDirectoryNames()) {
            command.add("--glob");
            command.add("!" + ignored + "/**");
        }
        if (glob != null && !glob.isBlank()) {
            command.add("--glob");
            command.add(glob.trim());
        }
        command.add("--");
        command.add(searchRoot.toString());

        Process process = null;
        try {
            process = new ProcessBuilder(command)
                    .directory(root.toFile())
                    .redirectErrorStream(false)
                    .start();

            List<GrepResult.GrepMatch> matches = new ArrayList<>();
            boolean truncated = false;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (matches.size() >= limit) {
                        truncated = true;
                        break;
                    }
                    GrepResult.GrepMatch match = parseRipgrepLine(root, line);
                    if (match != null) {
                        matches.add(match);
                    }
                }
            }

            process.waitFor(RIPGREP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            process.destroyForcibly();
            return new GrepResult(pattern, List.copyOf(matches), truncated, "ripgrep",
                    matches.isEmpty() ? "没有任何匹配" : null);
        } catch (IOException ex) {
            if (process != null) {
                process.destroyForcibly();
            }
            log.debug("调用 ripgrep 失败: {}", ex.getMessage());
            return null;
        } catch (InterruptedException ex) {
            if (process != null) {
                process.destroyForcibly();
            }
            Thread.currentThread().interrupt();
            return null;
        }
    }

    /** 解析 {@code path:line:text}；Windows 盘符会带来额外的冒号，所以从右侧找分隔符。 */
    private GrepResult.GrepMatch parseRipgrepLine(Path root, String line) {
        int firstColon = line.indexOf(':');
        if (firstColon <= 0) {
            return null;
        }
        int secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon <= firstColon) {
            return null;
        }
        String rawFile = line.substring(0, firstColon);
        String rawLine = line.substring(firstColon + 1, secondColon);
        String text = line.substring(secondColon + 1);
        try {
            int lineNumber = Integer.parseInt(rawLine.trim());
            return new GrepResult.GrepMatch(toRelative(root, rawFile), lineNumber, truncate(text));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    // ---------------------------------------------------------- Java 兜底

    private GrepResult searchWithJava(Path root, Path searchRoot, String pattern, Pattern compiled) {
        int limit = properties.grepMaxResults();
        List<GrepResult.GrepMatch> matches = new ArrayList<>();
        boolean[] truncated = {false};
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(JAVA_SCAN_TIMEOUT_MILLIS);
        int[] scannedFiles = {0};

        try (Stream<Path> walk = Files.walk(searchRoot)) {
            walk.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .filter(path -> !IgnoreRules.isIgnoredDirectory(path.getParent()))
                    .filter(path -> !containsIgnoredSegment(root, path))
                    .forEach(path -> {
                        if (matches.size() >= limit || System.nanoTime() > deadline
                                || scannedFiles[0] >= MAX_SCANNED_FILES) {
                            truncated[0] = true;
                            return;
                        }
                        scannedFiles[0]++;
                        scanFile(root, path, compiled, matches, limit);
                    });
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "搜索失败: " + ex.getMessage(), ex);
        }

        if (matches.size() > limit) {
            truncated[0] = true;
            matches.subList(limit, matches.size()).clear();
        }
        return new GrepResult(pattern, List.copyOf(matches), truncated[0], "java",
                matches.isEmpty() ? "没有任何匹配" : null);
    }

    private void scanFile(Path root, Path file, Pattern compiled,
                          List<GrepResult.GrepMatch> matches, int limit) {
        try {
            if (Files.size(file) > MAX_SCANNED_FILE_BYTES) {
                return;
            }
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            String relative = toRelative(root, file.toString());
            for (int i = 0; i < lines.size() && matches.size() < limit; i++) {
                String text = lines.get(i);
                if (compiled.matcher(text).find()) {
                    matches.add(new GrepResult.GrepMatch(relative, i + 1, truncate(text)));
                }
            }
        } catch (IOException ex) {
            // 二进制 / 无权限 / 编码异常的文件直接跳过，不影响整体搜索
            log.trace("跳过不可读文件 {}: {}", file, ex.getMessage());
        }
    }

    // ---------------------------------------------------------------- 工具

    private Pattern compile(String pattern) {
        if (pattern == null || pattern.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "搜索模式不能为空");
        }
        if (pattern.length() > MAX_PATTERN_LENGTH) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "搜索模式过长（上限 " + MAX_PATTERN_LENGTH + " 字符）");
        }
        try {
            return Pattern.compile(pattern);
        } catch (PatternSyntaxException ex) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "正则表达式不合法: " + ex.getDescription());
        }
    }

    private boolean containsIgnoredSegment(Path root, Path path) {
        Path relative;
        try {
            relative = root.relativize(path);
        } catch (IllegalArgumentException ex) {
            return true;
        }
        for (Path segment : relative) {
            if (IgnoreRules.isIgnoredDirectory(segment.toString())) {
                return true;
            }
        }
        return false;
    }

    private String toRelative(Path root, String rawPath) {
        try {
            Path path = Path.of(rawPath).toAbsolutePath().normalize();
            if (path.startsWith(root)) {
                return root.relativize(path).toString().replace('\\', '/');
            }
        } catch (RuntimeException ex) {
            log.trace("相对化路径失败: {}", rawPath);
        }
        return rawPath.replace('\\', '/');
    }

    private static String truncate(String text) {
        String trimmed = text.strip();
        return trimmed.length() > MAX_LINE_LENGTH ? trimmed.substring(0, MAX_LINE_LENGTH) + "…" : trimmed;
    }

    private static String locateRipgrep() {
        String override = System.getenv("RG_PATH");
        if (override != null && !override.isBlank() && Files.isExecutable(Path.of(override))) {
            return override;
        }
        String[] candidates = isWindows() ? new String[]{"rg.exe", "rg"} : new String[]{"rg"};
        for (String candidate : candidates) {
            if (isOnPath(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private static boolean isOnPath(String executable) {
        String pathEnv = System.getenv("PATH");
        if (pathEnv == null) {
            return false;
        }
        for (String dir : pathEnv.split(java.io.File.pathSeparator)) {
            if (dir.isBlank()) {
                continue;
            }
            try {
                if (Files.isExecutable(Path.of(dir, executable))) {
                    return true;
                }
            } catch (RuntimeException ex) {
                // 非法的 PATH 片段直接忽略
            }
        }
        return false;
    }
}
