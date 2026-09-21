package com.webcode.assistant.map;

import com.webcode.assistant.workspace.IgnoreRules;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Spring 地图 —— 把工作区里的 Spring 组件扫成一张「谁是谁、谁依赖谁」的地图。
 *
 * <p>三个层次的问题，一次扫描全部回答：
 * <ol>
 *   <li><b>有哪些 Bean</b>：按构造型注解分类（Controller / Service / Repository /
 *       Component / Configuration）；</li>
 *   <li><b>对外暴露什么接口</b>：类级 @RequestMapping 前缀 + 方法级
 *       @GetMapping / @PostMapping 等映射；</li>
 *   <li><b>谁依赖谁</b>：构造器注入的字段类型如果恰好是地图上的另一个 Bean，连一条边。</li>
 * </ol>
 *
 * <p>实现刻意停留在<b>正则 + 行扫描</b>而不是引入 JavaParser：扫描要在用户每次打开
 * 地图时全量重跑（工作区文件随时会被补丁改掉），正则版的成本是毫秒级，
 * 也不存在解析器版本与工作区 JDK 不兼容的问题。代价是注释里的误报 ——
 * 对「地图」这个用途可以接受，且所有节点都附了文件与行号，点开即可人工核实。
 *
 * <p>非 Spring 工作区返回空节点列表 —— 明确说「没找到」，不硬凑结论。
 */
@Service
public class SpringMapService {

    private static final Logger log = LoggerFactory.getLogger(SpringMapService.class);

    private static final int MAX_FILES_SCANNED = 3000;
    private static final int MAX_NODES = 400;
    private static final long MAX_FILE_BYTES = 256 * 1024L;

    /** 类声明与其行内可能同时出现的构造型注解分开抓：注解在声明行的上一行或同文件更早处。 */
    private static final Pattern TYPE_DECL =
            Pattern.compile("\\b(?:class|interface|record|enum)\\s+(\\w+)");

    private static final Pattern STEREOTYPE = Pattern.compile(
            "@(RestController|ControllerAdvice|RestControllerAdvice|Controller|Service|Repository"
                    + "|Component|Configuration|ConfigurationProperties|Entity)\\b");

    private static final Pattern BASE_MAPPING = Pattern.compile(
            "@RequestMapping\\s*\\(\\s*(?:value\\s*=\\s*)?\"([^\"]*)\"");

    private static final Pattern METHOD_MAPPING = Pattern.compile(
            "@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)"
                    + "(?:\\s*\\(\\s*(?:value\\s*=\\s*)?\"([^\"]*)\")?");

    /** 构造器注入的特征：private final 字段。字段注入（@Autowired）不连边，但会被单独列出。 */
    private static final Pattern FINAL_FIELD = Pattern.compile(
            "\\bprivate\\s+final\\s+(\\w+)\\s+(\\w+)\\s*;");

    private static final Pattern FIELD_AUTOWIRED = Pattern.compile(
            "@Autowired\\s+\\r?\\n?\\s*private\\s+(?:transient\\s+)?(\\w+)\\s+\\w+");

    private static final Pattern JAVA_FILE = Pattern.compile(".*\\.java$");

    private final WorkspacePathResolver pathResolver;

    public SpringMapService(WorkspacePathResolver pathResolver) {
        this.pathResolver = pathResolver;
    }

    public SpringMapData scan(Workspace workspace) {
        Path root;
        try {
            root = pathResolver.rootOf(workspace.rootPath());
        } catch (RuntimeException ex) {
            return new SpringMapData(workspace.name(), 0, List.of(), List.of(), false,
                    "无法定位工作区目录：" + ex.getMessage());
        }
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            return new SpringMapData(workspace.name(), 0, List.of(), List.of(), false, "工作区目录不存在");
        }

        List<Path> javaFiles = new ArrayList<>();
        boolean walkTruncated = false;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile)
                    .filter(path -> !IgnoreRules.isIgnoredDirectory(path))
                    .filter(path -> JAVA_FILE.matcher(path.getFileName().toString()).matches())
                    .limit(MAX_FILES_SCANNED + 1L)
                    .forEach(javaFiles::add);
        } catch (IOException ex) {
            log.warn("Spring 地图扫描失败 workspace={}: {}", workspace.name(), ex.getMessage());
            return new SpringMapData(workspace.name(), 0, List.of(), List.of(), false,
                    "扫描文件时出错：" + ex.getMessage());
        }
        if (javaFiles.size() > MAX_FILES_SCANNED) {
            walkTruncated = true;
            javaFiles = javaFiles.subList(0, MAX_FILES_SCANNED);
        }

        Map<String, Node> nodes = new LinkedHashMap<>();
        Map<String, String> fieldInjection = new HashMap<>();

        for (Path file : javaFiles) {
            if (nodes.size() >= MAX_NODES) {
                walkTruncated = true;
                break;
            }
            scanFile(root, file, nodes, fieldInjection);
        }

        // 连边：构造器注入字段的类型命中已识别的 Bean 就连一条
        List<Edge> edges = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Map.Entry<String, String> entry : fieldInjection.entrySet()) {
            String from = entry.getKey();
            String fieldType = entry.getValue();
            Node target = nodes.get(fieldType);
            if (target == null || target.name().equals(from)) {
                continue;
            }
            String key = from + "->" + fieldType;
            if (seen.add(key)) {
                edges.add(new Edge(from, fieldType));
            }
        }
        edges.sort(Comparator.comparing(Edge::from).thenComparing(Edge::to));

        List<Node> sorted = nodes.values().stream()
                .sorted(Comparator.comparing(Node::layer)
                        .thenComparing(Node::name))
                .toList();
        String note = sorted.isEmpty()
                ? "工作区里没有发现 Spring 构造型组件（@Controller/@Service/@Repository 等）—— 非 Spring 项目无法绘制地图。"
                : "识别到 " + sorted.size() + " 个 Bean、" + edges.size() + " 条依赖注入关系。";
        return new SpringMapData(workspace.name(), javaFiles.size(), sorted, edges, walkTruncated, note);
    }

    // ------------------------------------------------------------ 单文件扫描

    private void scanFile(Path root, Path file, Map<String, Node> nodes, Map<String, String> fieldInjection) {
        String text;
        try {
            if (Files.size(file) > MAX_FILE_BYTES) {
                return;
            }
            text = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException ex) {
            return;
        }

        String relative = root.relativize(file).toString().replace('\\', '/');
        String[] lines = text.split("\\r?\\n");

        // 先找构造型注解（注解在类声明之前的 N 行内），锁定这个文件是否值得细扫
        String stereotype = null;
        int stereotypeLine = -1;
        for (int i = 0; i < lines.length; i++) {
            Matcher matcher = STEREOTYPE.matcher(lines[i]);
            if (matcher.find()) {
                stereotype = normalizeStereotype(matcher.group(1));
                stereotypeLine = i + 1;
                break;
            }
        }
        if (stereotype == null) {
            // 不是组件：仍需检查它是否被别的组件以 final 字段引用（那是接口/实体，不建节点）
            return;
        }

        String className = null;
        int classLine = stereotypeLine;
        for (int i = stereotypeLine - 1; i < Math.min(lines.length, stereotypeLine + 6); i++) {
            Matcher matcher = TYPE_DECL.matcher(lines[i]);
            if (matcher.find()) {
                className = matcher.group(1);
                classLine = i + 1;
                break;
            }
        }
        if (className == null) {
            return;
        }

        String basePath = null;
        List<String> endpoints = new ArrayList<>();
        Set<String> injectedFieldTypes = new HashSet<>();
        boolean fieldInjectionStyle = false;

        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            if (basePath == null && line.contains("@RequestMapping")) {
                Matcher matcher = BASE_MAPPING.matcher(line);
                if (matcher.find()) {
                    basePath = matcher.group(1);
                }
            }
            Matcher mapping = METHOD_MAPPING.matcher(line);
            while (mapping.find()) {
                String verb = mapping.group(1).replace("Mapping", "").toUpperCase(java.util.Locale.ROOT);
                String path = mapping.group(2) == null ? "" : mapping.group(2);
                endpoints.add(verb + " " + joinPath(basePath, path));
            }
            Matcher field = FINAL_FIELD.matcher(line);
            if (field.find()) {
                injectedFieldTypes.add(field.group(1));
            }
            if (line.contains("@Autowired")) {
                fieldInjectionStyle = true;
            }
        }
        if (fieldInjectionStyle) {
            Matcher autowired = FIELD_AUTOWIRED.matcher(text);
            while (autowired.find()) {
                injectedFieldTypes.add(autowired.group(1));
            }
        }

        String layer = layerOf(stereotype);
        nodes.put(className, new Node(className, stereotype, layer, relative, classLine,
                basePath, List.copyOf(endpoints)));

        // 字段注入的依赖也参与连边，但单独记录，便于地图上提示「这是字段注入」
        for (String type : injectedFieldTypes) {
            fieldInjection.putIfAbsent(className, type);
        }
    }

    // ------------------------------------------------------------ 工具

    private static String normalizeStereotype(String annotation) {
        return switch (annotation) {
            case "RestController" -> "Controller";
            case "ControllerAdvice", "RestControllerAdvice" -> "ControllerAdvice";
            default -> annotation;
        };
    }

    private static String layerOf(String stereotype) {
        return switch (stereotype) {
            case "Controller" -> "1-web";
            case "Service" -> "2-service";
            case "Repository" -> "3-repository";
            case "Entity" -> "4-model";
            case "Configuration" -> "0-config";
            default -> "5-other";
        };
    }

    private static String joinPath(String base, String path) {
        if (base == null || base.isBlank() || "/".equals(base)) {
            return path.isEmpty() ? "/" : path;
        }
        if (path.isEmpty()) {
            return base;
        }
        if (path.startsWith("/")) {
            return base.endsWith("/") ? base + path.substring(1) : base + path;
        }
        return base.endsWith("/") ? base + path : base + "/" + path;
    }

    // ------------------------------------------------------------ 数据模型

    /**
     * @param name         类名（Spring Bean 名的来源）
     * @param stereotype   归一化后的构造型（Controller / Service / Repository / …）
     * @param layer        分层排序键（1-web / 2-service / …），仅用于地图从上到下排列
     * @param file         相对工作区根的文件路径，点击可跳转
     * @param line         类声明行号
     * @param basePath     类级 @RequestMapping 前缀（没有为 null）
     * @param endpoints    该类暴露的 HTTP 端点（"GET /api/users" 形式）
     */
    public record Node(String name, String stereotype, String layer, String file, int line,
                       String basePath, List<String> endpoints) {
    }

    /** 一条依赖注入关系：from 的构造器里注入了 to 类型的 Bean。 */
    public record Edge(String from, String to) {
    }

    /**
     * @param scannedFiles 实际扫描的 Java 文件数
     * @param nodes        Bean 节点（已按层排序）
     * @param edges        依赖注入边
     * @param truncated    是否因为文件数/节点数上限被截断
     * @param note         给用户看的一句话说明（空地图时会解释原因）
     */
    public record SpringMapData(String workspaceName, int scannedFiles, List<Node> nodes,
                                List<Edge> edges, boolean truncated, String note) {
    }
}
