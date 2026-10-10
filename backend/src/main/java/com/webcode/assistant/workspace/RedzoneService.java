package com.webcode.assistant.workspace;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 禁区：用户划定「Agent 不得提出补丁」的路径。
 *
 * <p>和宪法不同 —— 宪法是给模型看的软约束，模型仍可能试着改；
 * 禁区是生成补丁与应用补丁两道闸门上的硬拒绝。Cursor 的 ignore 只影响索引，
 * 这里是「这张底片根本不让它出补丁」。
 *
 * <p>落盘在 {@code .wca/REDZONE}，一行一条路径。Agent 没有任何工具能改这个文件。
 */
@Service
public class RedzoneService {

    private static final Logger log = LoggerFactory.getLogger(RedzoneService.class);
    public static final String REDZONE_PATH = ".wca/REDZONE";
    private static final int MAX_RULES = 80;
    private static final int MAX_PATH = 512;

    /** 永远禁：宪法和禁区名单自己不能被补丁改掉。 */
    private static final List<String> ALWAYS = List.of(
            ".wca/constitution.md",
            ".wca/redzone"
    );

    private final WorkspacePathResolver pathResolver;

    public RedzoneService(WorkspacePathResolver pathResolver) {
        this.pathResolver = pathResolver;
    }

    public List<String> list(Workspace workspace) {
        return new ArrayList<>(readRules(workspace));
    }

    public List<String> save(Workspace workspace, List<String> incoming) {
        LinkedHashSet<String> rules = new LinkedHashSet<>();
        if (incoming != null) {
            for (String raw : incoming) {
                String path = normalize(raw);
                if (path == null || ALWAYS.contains(path)) {
                    continue;
                }
                rules.add(path);
            }
        }
        if (rules.size() > MAX_RULES) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "禁区最多 " + MAX_RULES + " 条");
        }
        writeRules(workspace, rules);
        return new ArrayList<>(rules);
    }

    public List<String> toggle(Workspace workspace, String rawPath) {
        String path = normalize(rawPath);
        if (path == null) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "路径不合法");
        }
        if (ALWAYS.contains(path)) {
            throw new ApiException(ErrorCode.FORBIDDEN, "宪法和禁区名单本身不能移出禁区");
        }
        LinkedHashSet<String> rules = new LinkedHashSet<>(readRules(workspace));
        if (rules.contains(path)) {
            rules.remove(path);
        } else {
            if (rules.size() >= MAX_RULES) {
                throw new ApiException(ErrorCode.BAD_REQUEST, "禁区最多 " + MAX_RULES + " 条");
            }
            rules.add(path);
        }
        writeRules(workspace, rules);
        return new ArrayList<>(rules);
    }

    /** 这条路径是否被禁（含父目录命中与系统内置）。 */
    public boolean blocks(Workspace workspace, String filePath) {
        String path = normalize(filePath);
        if (path == null) {
            return false;
        }
        if (ALWAYS.stream().anyMatch(rule -> matches(path, rule))) {
            return true;
        }
        for (String rule : readRules(workspace)) {
            if (matches(path, rule)) {
                return true;
            }
        }
        return false;
    }

    /** 命中时返回规则原文，供报错。 */
    public String blockingRule(Workspace workspace, String filePath) {
        String path = normalize(filePath);
        if (path == null) {
            return null;
        }
        for (String rule : ALWAYS) {
            if (matches(path, rule)) {
                return rule;
            }
        }
        for (String rule : readRules(workspace)) {
            if (matches(path, rule)) {
                return rule;
            }
        }
        return null;
    }

    private static boolean matches(String path, String rule) {
        return path.equals(rule) || path.startsWith(rule + "/");
    }

    private static String normalize(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String path = raw.trim().replace('\\', '/').toLowerCase(Locale.ROOT);
        while (path.startsWith("./")) {
            path = path.substring(2);
        }
        while (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        if (path.isBlank() || path.length() > MAX_PATH || path.contains("..")) {
            return null;
        }
        return path;
    }

    private Set<String> readRules(Workspace workspace) {
        Path file = redzoneFile(workspace);
        if (file == null || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return Set.of();
        }
        try {
            LinkedHashSet<String> rules = new LinkedHashSet<>();
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                    continue;
                }
                String path = normalize(trimmed);
                if (path != null) {
                    rules.add(path);
                }
            }
            return rules;
        } catch (IOException ex) {
            log.warn("读取禁区失败 workspace={}: {}", workspace.name(), ex.getMessage());
            return Set.of();
        }
    }

    private void writeRules(Workspace workspace, Set<String> rules) {
        Path file = redzoneFile(workspace);
        if (file == null) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "无法定位工作区根目录");
        }
        try {
            Files.createDirectories(file.getParent());
            if (rules.isEmpty()) {
                Files.deleteIfExists(file);
                return;
            }
            Files.writeString(file, String.join("\n", rules) + "\n", StandardCharsets.UTF_8);
        } catch (IOException ex) {
            log.warn("写入禁区失败 workspace={}: {}", workspace.name(), ex.getMessage());
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "禁区写入失败：" + ex.getMessage());
        }
    }

    private Path redzoneFile(Workspace workspace) {
        try {
            return pathResolver.rootOf(workspace.rootPath()).resolve(".wca").resolve("REDZONE");
        } catch (RuntimeException ex) {
            return null;
        }
    }
}
