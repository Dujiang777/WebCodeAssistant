package com.webcode.assistant.workspace;

import java.nio.file.FileSystems;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.Set;

/**
 * 工作区内的忽略规则 —— 文件树、grep、体积统计共用一份，避免三处各写一遍导致行为不一致。
 *
 * <p>这些目录要么是构建产物，要么是元数据，排除它们能显著减少噪声与 token 消耗。
 */
public final class IgnoreRules {

    private static final Set<String> IGNORED_DIRECTORIES = Set.of(
            ".git", ".hg", ".svn",
            "node_modules", "bower_components",
            "target", "build", "out", "bin", "dist",
            ".gradle", ".mvn", ".m2",
            ".idea", ".vscode", ".settings",
            "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv",
            ".next", ".nuxt", ".cache", ".parcel-cache",
            "coverage", ".terraform");

    /** 体积统计时额外跳过的二进制/压缩产物，避免把构建产物算进配额。 */
    private static final PathMatcher BINARY_ARCHIVE_MATCHER =
            FileSystems.getDefault().getPathMatcher("glob:**/*.{jar,war,zip,tar,gz,7z,rar,class,exe,dll,so,dylib}");

    private IgnoreRules() {
    }

    public static boolean isIgnoredDirectory(String fileName) {
        return IGNORED_DIRECTORIES.contains(fileName);
    }

    public static boolean isIgnoredDirectory(Path path) {
        Path fileName = path.getFileName();
        return fileName != null && IGNORED_DIRECTORIES.contains(fileName.toString());
    }

    public static boolean isArchiveLike(Path path) {
        return BINARY_ARCHIVE_MATCHER.matches(path);
    }

    /** 供 UI 与文档展示。 */
    public static Set<String> ignoredDirectoryNames() {
        return IGNORED_DIRECTORIES;
    }
}
