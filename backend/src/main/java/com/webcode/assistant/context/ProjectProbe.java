package com.webcode.assistant.context;

import com.webcode.assistant.llm.LlmProperties;
import com.webcode.assistant.workspace.IgnoreRules;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 探测工作区「是什么项目」。
 *
 * <p>只读取少量文件的开头片段：目的是让模型第一轮就知道构建系统、JDK 版本和项目约定，
 * 而不是每次都靠 list_dir 试错。所有片段都有字符预算，避免上下文被一个 pom.xml 撑满。
 */
@Component
public class ProjectProbe {

    private static final Logger log = LoggerFactory.getLogger(ProjectProbe.class);

    private static final int BUILD_FILE_BUDGET = 2400;
    private static final int README_BUDGET = 1600;
    private static final int RULE_FILE_BUDGET = 4000;
    private static final int MAX_TOP_LEVEL_ENTRIES = 60;

    /** 构建系统候选，顺序即优先级。 */
    private static final List<BuildDescriptor> BUILD_FILES = List.of(
            new BuildDescriptor("pom.xml", "Maven", "Java"),
            new BuildDescriptor("build.gradle.kts", "Gradle (Kotlin DSL)", "Java"),
            new BuildDescriptor("build.gradle", "Gradle", "Java"),
            new BuildDescriptor("settings.gradle.kts", "Gradle (Kotlin DSL)", "Java"),
            new BuildDescriptor("package.json", "npm", "JavaScript/TypeScript"),
            new BuildDescriptor("go.mod", "Go Modules", "Go"),
            new BuildDescriptor("Cargo.toml", "Cargo", "Rust"),
            new BuildDescriptor("requirements.txt", "pip", "Python"),
            new BuildDescriptor("pyproject.toml", "pyproject", "Python"));

    private static final List<String> README_CANDIDATES =
            List.of("README.md", "README.MD", "readme.md", "README.txt", "README");

    private final WorkspacePathResolver pathResolver;
    private final LlmProperties llmProperties;

    public ProjectProbe(WorkspacePathResolver pathResolver, LlmProperties llmProperties) {
        this.pathResolver = pathResolver;
        this.llmProperties = llmProperties;
    }

    public ProjectSummary probe(Workspace workspace) {
        Path root = pathResolver.rootOf(workspace.rootPath());
        if (!Files.isDirectory(root)) {
            return new ProjectSummary(workspace.name(), "未知", null, null, null, null, null, List.of());
        }

        BuildDescriptor build = null;
        String buildExcerpt = null;
        for (BuildDescriptor candidate : BUILD_FILES) {
            String excerpt = readHead(root.resolve(candidate.fileName()), BUILD_FILE_BUDGET);
            if (excerpt != null) {
                build = candidate;
                buildExcerpt = excerpt;
                break;
            }
        }

        String readmeExcerpt = null;
        for (String candidate : README_CANDIDATES) {
            readmeExcerpt = readHead(root.resolve(candidate), README_BUDGET);
            if (readmeExcerpt != null) {
                break;
            }
        }

        String ruleFileName = null;
        String ruleContent = null;
        for (String candidate : llmProperties.ruleFiles()) {
            String content = readHead(root.resolve(candidate), RULE_FILE_BUDGET);
            if (content != null) {
                ruleFileName = candidate;
                ruleContent = content;
                break;
            }
        }

        return new ProjectSummary(
                workspace.name(),
                build == null ? detectLanguageByExtension(root) : build.language(),
                build == null ? null : build.label() + " (" + build.fileName() + ")",
                buildExcerpt,
                readmeExcerpt,
                ruleFileName,
                ruleContent,
                listTopLevel(root));
    }

    private List<String> listTopLevel(Path root) {
        try (Stream<Path> stream = Files.list(root)) {
            return stream
                    .filter(path -> !IgnoreRules.isIgnoredDirectory(path))
                    .sorted(Comparator
                            .comparing((Path path) -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) ? 0 : 1)
                            .thenComparing(path -> path.getFileName().toString()))
                    .limit(MAX_TOP_LEVEL_ENTRIES)
                    .map(path -> path.getFileName().toString()
                            + (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) ? "/" : ""))
                    .toList();
        } catch (IOException ex) {
            log.warn("列出顶层目录失败: {}", root, ex);
            return List.of();
        }
    }

    /** 没有构建文件时，按出现最多的源码扩展名猜一个语言标签。 */
    private String detectLanguageByExtension(Path root) {
        String[] extensions = {".java", ".kt", ".ts", ".tsx", ".js", ".py", ".go", ".rs", ".cs", ".rb", ".php"};
        int[] counts = new int[extensions.length];
        int[] scanned = {0};
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .limit(5000)
                    .forEach(path -> {
                        scanned[0]++;
                        String name = path.getFileName().toString();
                        for (int i = 0; i < extensions.length; i++) {
                            if (name.endsWith(extensions[i])) {
                                counts[i]++;
                                return;
                            }
                        }
                    });
        } catch (IOException ex) {
            return "未知";
        }
        int best = 0;
        for (int i = 1; i < counts.length; i++) {
            if (counts[i] > counts[best]) {
                best = i;
            }
        }
        if (counts[best] == 0) {
            return scanned[0] > 0 ? "未知" : "空工作区";
        }
        return switch (extensions[best]) {
            case ".java" -> "Java";
            case ".kt" -> "Kotlin";
            case ".ts", ".tsx" -> "TypeScript";
            case ".js" -> "JavaScript";
            case ".py" -> "Python";
            case ".go" -> "Go";
            case ".rs" -> "Rust";
            case ".cs" -> "C#";
            case ".rb" -> "Ruby";
            case ".php" -> "PHP";
            default -> "未知";
        };
    }

    /** 读取文件开头；不存在或读取失败返回 null。 */
    private String readHead(Path file, int budget) {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        try (var reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            char[] buffer = new char[budget];
            int read = reader.read(buffer);
            if (read <= 0) {
                return null;
            }
            String text = new String(buffer, 0, read);
            return read == budget ? text + "\n…（已截断）" : text;
        } catch (IOException ex) {
            log.debug("读取 {} 失败: {}", file, ex.getMessage());
            return null;
        }
    }

    private record BuildDescriptor(String fileName, String label, String language) {
    }
}
