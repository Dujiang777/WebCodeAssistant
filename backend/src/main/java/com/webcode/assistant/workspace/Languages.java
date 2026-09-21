package com.webcode.assistant.workspace;

import java.util.Locale;
import java.util.Map;

/**
 * 由文件扩展名推断 Monaco 语言标识。前端只负责把标识塞给 Monaco，
 * 后端靠它决定送给模型的代码块语言标注。
 */
public final class Languages {

    private static final Map<String, String> BY_EXTENSION = Map.ofEntries(
            Map.entry("java", "java"),
            Map.entry("kt", "kotlin"), Map.entry("kts", "kotlin"),
            Map.entry("groovy", "groovy"), Map.entry("gradle", "groovy"),
            Map.entry("xml", "xml"), Map.entry("pom", "xml"),
            Map.entry("yml", "yaml"), Map.entry("yaml", "yaml"),
            Map.entry("properties", "ini"), Map.entry("conf", "ini"), Map.entry("ini", "ini"),
            Map.entry("json", "json"), Map.entry("jsonc", "json"),
            Map.entry("js", "javascript"), Map.entry("mjs", "javascript"), Map.entry("cjs", "javascript"),
            Map.entry("jsx", "javascript"),
            Map.entry("ts", "typescript"), Map.entry("tsx", "typescript"),
            Map.entry("vue", "html"), Map.entry("svelte", "html"),
            Map.entry("html", "html"), Map.entry("htm", "html"),
            Map.entry("css", "css"), Map.entry("scss", "scss"), Map.entry("less", "less"),
            Map.entry("md", "markdown"), Map.entry("markdown", "markdown"),
            Map.entry("sql", "sql"),
            Map.entry("sh", "shell"), Map.entry("bash", "shell"), Map.entry("zsh", "shell"),
            Map.entry("bat", "bat"), Map.entry("cmd", "bat"),
            Map.entry("ps1", "powershell"),
            Map.entry("py", "python"),
            Map.entry("go", "go"),
            Map.entry("rs", "rust"),
            Map.entry("c", "c"), Map.entry("h", "c"),
            Map.entry("cpp", "cpp"), Map.entry("hpp", "cpp"), Map.entry("cc", "cpp"),
            Map.entry("cs", "csharp"),
            Map.entry("rb", "ruby"),
            Map.entry("php", "php"),
            Map.entry("swift", "swift"),
            Map.entry("dart", "dart"),
            Map.entry("dockerfile", "dockerfile"),
            Map.entry("toml", "ini"),
            Map.entry("env", "ini"));

    private static final Map<String, String> BY_FILE_NAME = Map.of(
            "dockerfile", "dockerfile",
            "makefile", "makefile",
            ".gitignore", "ini",
            ".dockerignore", "ini",
            ".env", "ini",
            ".editorconfig", "ini");

    private Languages() {
    }

    public static String detect(String path) {
        if (path == null || path.isBlank()) {
            return "plaintext";
        }
        String fileName = path;
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (slash >= 0) {
            fileName = path.substring(slash + 1);
        }
        String lowerName = fileName.toLowerCase(Locale.ROOT);
        String byName = BY_FILE_NAME.get(lowerName);
        if (byName != null) {
            return byName;
        }
        int dot = lowerName.lastIndexOf('.');
        if (dot < 0 || dot == lowerName.length() - 1) {
            return "plaintext";
        }
        return BY_EXTENSION.getOrDefault(lowerName.substring(dot + 1), "plaintext");
    }

    /** 该语言是否属于「代码」——用于决定是否值得做代码检索/摘要。 */
    public static boolean isCode(String language) {
        return !"plaintext".equals(language) && !"markdown".equals(language);
    }
}
