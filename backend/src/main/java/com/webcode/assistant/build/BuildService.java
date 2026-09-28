package com.webcode.assistant.build;

import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 编译验证与测试运行 —— 「Patch → compile → 自动修」和「测试失败驱动改代码」
 * 两个闭环里真正执行构建的那一环。
 *
 * <p>设计要点：
 * <ol>
 *   <li><b>用项目自己的构建方式</b>，不猜。有 {@code pom.xml} 就用 Maven，有
 *       {@code build.gradle} 就用 Gradle；本地有 wrapper 就优先用 wrapper ——
 *       这样构建出来的结果和用户在 CI 里看到的一致；</li>
 *   <li><b>「没执行」必须与「通过」区分开</b>。找不到构建工具时返回
 *       {@code unavailable} 而不是 {@code ok}：一个谎报成功的检查比没有检查更糟；</li>
 *   <li><b>输出裁剪到尾部</b>。构建输出动辄上万行，而错误和结论总在末尾；</li>
 *   <li><b>超时就杀</b>。第一次构建要下载依赖，可能很久，但也不能无限等 —— 杀掉进程并如实报告。</li>
 * </ol>
 *
 * <p>安全边界：构建过程在<b>工作区目录内</b>执行，命令与参数全部由服务端拼装，
 * 模型无法往里注入任何东西（它可以调用 {@code run_tests} 工具，但选不了 goal，
 * 更塞不进自定义参数）。这与「V2 沙盒」的差距在于隔离级别，README 的「已知限制」里写明了。
 */
@Service
public class BuildService {

    private static final Logger log = LoggerFactory.getLogger(BuildService.class);

    private static final int MAX_ISSUES = 60;
    private static final int MAX_TEST_FAILURES = 40;

    /**
     * 匹配两种主流格式：
     * <pre>
     *   [ERROR] /abs/path/File.java:[12,34] cannot find symbol      (Maven)
     *   /abs/path/File.java:12: error: cannot find symbol           (javac / Gradle)
     * </pre>
     */
    private static final Pattern ISSUE = Pattern.compile(
            "([^\\s\\[\\]:]+\\.(?:java|kt|kts|scala))"
                    + ":(?:\\[(\\d+)\\s*,\\s*(\\d+)\\]|(\\d+))"
                    + ":?\\s*(?:(error|warning)\\s*:)?\\s*(.*)");

    private static final Pattern ANSI = Pattern.compile("\u001B\\[[;\\d]*m");

    /** Maven surefire 聚合统计：Tests run: 5, Failures: 1, Errors: 0, Skipped: 0 */
    private static final Pattern SUREFIRE_TOTALS = Pattern.compile(
            "Tests run:\\s*(\\d+),\\s*Failures:\\s*(\\d+),\\s*Errors:\\s*(\\d+)(?:,\\s*Skipped:\\s*(\\d+))?");

    /** 失败断言行：[ERROR]   UserServiceTest.testGreeting:23 expected: &lt;x&gt; but was: &lt;y&gt; */
    private static final Pattern SUREFIRE_FAILURE = Pattern.compile(
            "\\[ERROR\\]\\s+(\\w+)\\.(\\w+):(\\d+)\\s+(.*)");

    /** 失败用例行（无行号）：[ERROR]   UserServiceTest.testGreeting  Time elapsed: 0.01 s  &lt;&lt;&lt; FAILURE! */
    private static final Pattern SUREFIRE_ELAPSED = Pattern.compile(
            "\\[ERROR\\]\\s+(\\w+)\\.(\\w+)\\s+Time elapsed.*<<<\\s*(FAILURE|ERROR)");

    /** Gradle 失败行：UserServiceTest > testGreeting FAILED */
    private static final Pattern GRADLE_FAILURE = Pattern.compile(
            "([\\w$]+)\\s*>\\s*([\\w$]+)\\s+FAILED");

    private final AppProperties appProperties;
    private final WorkspaceFileService fileService;

    public BuildService(AppProperties appProperties, WorkspaceFileService fileService) {
        this.appProperties = appProperties;
        this.fileService = fileService;
    }

    /** 编译验证：只编译主代码（{@code compile} / {@code compileJava}）。 */
    public BuildResult compile(Workspace workspace) {
        AppProperties.Compile config = appProperties.compile();
        if (!config.enabled()) {
            return BuildResult.skipped(BuildResult.DISABLED, "编译验证已在服务端关闭（COMPILE_ENABLED=false）。");
        }

        Toolchain toolchain = prepare(workspace, "编译验证");
        if (toolchain.error() != null) {
            return BuildResult.skipped(toolchain.errorStatus(), toolchain.error());
        }

        List<String> goals = "maven".equals(toolchain.system())
                ? List.of("compile")
                : List.of("compileJava");
        ProcessOutcome out = execute(workspace, toolchain, config, goals, true);
        int maxChars = config.maxOutputChars();

        if (out.startError() != null) {
            return new BuildResult(BuildResult.UNAVAILABLE, toolchain.system(), out.commandLine(),
                    null, out.durationMs(), "", List.of(), "无法启动构建进程：" + out.startError());
        }
        if (out.interrupted()) {
            return new BuildResult(BuildResult.TIMEOUT, toolchain.system(), out.commandLine(), null,
                    out.durationMs(), "", List.of(), "编译被中断。");
        }
        if (out.timedOut()) {
            return new BuildResult(BuildResult.TIMEOUT, toolchain.system(), out.commandLine(), null,
                    out.durationMs(), trim(out.rawOutput(), maxChars), List.of(),
                    "编译超过 " + config.timeout().toSeconds() + " 秒仍未结束，已终止。"
                            + "首次构建需要下载依赖时容易触发，可以把 COMPILE_TIMEOUT 调大，"
                            + "或先在工作区里手动构建一次预热本地仓库。");
        }

        int exitCode = out.exitCode();
        String output = trim(out.rawOutput(), maxChars);
        Path root = toolchain.root();
        List<CompileIssue> issues = exitCode == 0 ? List.of() : parseIssues(out.rawOutput(), root);
        String note = exitCode == 0 ? "编译通过。" : "编译失败，共解析出 " + issues.size() + " 条诊断。";
        log.info("编译验证结束 workspace={} exit={} 时长={}ms 诊断={}",
                workspace.name(), exitCode, out.durationMs(), issues.size());
        return new BuildResult(exitCode == 0 ? BuildResult.OK : BuildResult.FAILED,
                toolchain.system(), out.commandLine(), exitCode, out.durationMs(), output, issues, note);
    }

    /**
     * 运行测试套件（{@code test} goal）。返回结构与编译验证同构，
     * 额外解析出用例统计与失败明细 —— 那是「测试失败驱动改代码」的原料。
     */
    public TestRunResult runTests(Workspace workspace) {
        AppProperties.Compile config = appProperties.compile();
        if (!config.enabled()) {
            return TestRunResult.skipped(TestRunResult.DISABLED,
                    "构建执行已在服务端关闭（COMPILE_ENABLED=false），无法运行测试。");
        }

        Toolchain toolchain = prepare(workspace, "测试运行");
        if (toolchain.error() != null) {
            return TestRunResult.skipped(toolchain.errorStatus(), toolchain.error());
        }

        List<String> goals = List.of("test");
        ProcessOutcome out = execute(workspace, toolchain, config, goals, false);
        int maxChars = config.maxOutputChars();

        if (out.startError() != null) {
            return new TestRunResult(TestRunResult.UNAVAILABLE, toolchain.system(), out.commandLine(),
                    null, out.durationMs(), "", null, List.of(), List.of(), "无法启动构建进程：" + out.startError());
        }
        if (out.interrupted()) {
            return new TestRunResult(TestRunResult.TIMEOUT, toolchain.system(), out.commandLine(), null,
                    out.durationMs(), "", null, List.of(), List.of(), "测试被中断。");
        }
        if (out.timedOut()) {
            return new TestRunResult(TestRunResult.TIMEOUT, toolchain.system(), out.commandLine(), null,
                    out.durationMs(), trim(out.rawOutput(), maxChars), null, List.of(), List.of(),
                    "测试超过 " + config.timeout().toSeconds() + " 秒仍未结束，已终止。"
                            + "可以把 COMPILE_TIMEOUT 调大后重试。");
        }

        int exitCode = out.exitCode();
        String raw = out.rawOutput();
        TestRunResult.Totals totals = parseTotals(raw);
        List<TestRunResult.TestFailure> failures =
                exitCode == 0 ? List.of() : parseTestFailures(raw);
        // surefire 没跑（totals 为空）但退出码非 0，几乎总是测试代码编译不过 ——
        // 此时把编译诊断解析出来，模型才知道该修的是编译错误而不是断言。
        List<CompileIssue> issues = (exitCode != 0 && totals == null)
                ? parseIssues(raw, toolchain.root())
                : List.of();
        String note = buildTestNote(exitCode, totals, failures, issues);
        log.info("测试运行结束 workspace={} exit={} 时长={}ms 失败={} 编译诊断={}",
                workspace.name(), exitCode, out.durationMs(), failures.size(), issues.size());
        return new TestRunResult(exitCode == 0 ? TestRunResult.OK : TestRunResult.FAILED,
                toolchain.system(), out.commandLine(), exitCode, out.durationMs(),
                trim(raw, maxChars), totals, failures, issues, note);
    }

    // ------------------------------------------------------------ 内部实现

    /**
     * mvn 进程的 cwd 是<b>被编译的工作区目录</b>，{@code -s} 里的相对路径会相对工作区解析 ——
     * 而配置文件（如 {@code tools/maven-self-test-settings.xml}）在<b>部署根目录</b>下。
     * 这里把相对路径锚定到后端进程自己的启动目录，让「传相对路径」这种最自然的写法
     * 在任何 cwd 下都成立；绝对路径原样返回。
     */
    private static String anchorToLaunchDir(String configured) {
        Path path = Path.of(configured);
        if (path.isAbsolute()) {
            return configured;
        }
        return Path.of(System.getProperty("user.dir")).resolve(path).normalize().toString();
    }

    private record Toolchain(String system, String executable, String configuredCommand,
                             List<String> prefixArgs, Path root, String error, String errorStatus) {
    }

    /**
     * 定位构建体系与可执行文件。返回 {@code error != null} 时调用方应直接返回 skipped 结果。
     */
    private Toolchain prepare(Workspace workspace, String actionName) {
        Path root;
        try {
            root = fileService.rootOf(workspace);
        } catch (RuntimeException ex) {
            return new Toolchain("未知", null, null, List.of(), null,
                    "无法定位工作区目录：" + ex.getMessage(), BuildResult.UNAVAILABLE);
        }

        AppProperties.Compile config = appProperties.compile();
        boolean maven = Files.exists(root.resolve("pom.xml"));
        boolean gradle = Files.exists(root.resolve("build.gradle"))
                || Files.exists(root.resolve("build.gradle.kts"))
                || Files.exists(root.resolve("settings.gradle"))
                || Files.exists(root.resolve("settings.gradle.kts"));

        String system;
        String executable;
        String configured;
        List<String> prefix;
        if (maven) {
            system = "maven";
            configured = config.mavenCommand();
            executable = wrapper(root, "mvnw").orElseGet(() -> resolveExecutable(configured));
            List<String> args = new ArrayList<>(List.of("-B", "-Dstyle.color=never"));
            if (!config.mavenSettings().isBlank()) {
                args.add("-s");
                args.add(anchorToLaunchDir(config.mavenSettings().trim()));
            }
            if (config.offline()) {
                args.add("-o");
            }
            prefix = args;
        } else if (gradle) {
            system = "gradle";
            configured = config.gradleCommand();
            executable = wrapper(root, "gradlew").orElseGet(() -> resolveExecutable(configured));
            List<String> args = new ArrayList<>(List.of("--console=plain", "--no-daemon"));
            if (config.offline()) {
                args.add("--offline");
            }
            prefix = args;
        } else {
            return new Toolchain("未知", null, null, List.of(), root,
                    "工作区根目录下没有识别到构建文件（pom.xml / build.gradle[.kts]），已跳过" + actionName + "。",
                    BuildResult.UNAVAILABLE);
        }

        if (executable == null) {
            return new Toolchain(system, null, configured, prefix, root,
                    "识别到 " + system + " 工程，但在 PATH 上找不到 `" + configured + "`。"
                            + "可以用 COMPILE_MVN / COMPILE_GRADLE 指定绝对路径，或在 Docker 镜像里内置构建工具。",
                    BuildResult.UNAVAILABLE);
        }
        return new Toolchain(system, executable, configured, prefix, root, null, null);
    }

    private record ProcessOutcome(String commandLine, Integer exitCode, long durationMs,
                                  String rawOutput, boolean timedOut, boolean interrupted,
                                  String startError) {
    }

    /**
     * 统一的进程执行：拼 argv、启动、限时限读。
     * <p>编译与测试唯一的差别就是 goal 列表和是否要求安静输出（-q），
     * 进程管理逻辑必须共享 —— 两套实现迟早会修好一边忘了另一边。
     */
    private ProcessOutcome execute(Workspace workspace, Toolchain toolchain,
                                   AppProperties.Compile config, List<String> goals, boolean quiet) {
        List<String> argv = new ArrayList<>();
        if (isWindows() && (toolchain.executable().endsWith(".cmd") || toolchain.executable().endsWith(".bat"))) {
            // CreateProcess 不能直接执行 .cmd/.bat，必须套一层 cmd.exe
            argv.add("cmd.exe");
            argv.add("/c");
        }
        argv.add(toolchain.executable());
        argv.addAll(toolchain.prefixArgs());
        if (quiet && "maven".equals(toolchain.system())) {
            argv.add("-q");
        }
        argv.addAll(goals);

        String commandLine = String.join(" ", argv);
        long started = System.currentTimeMillis();

        ProcessBuilder builder = new ProcessBuilder(argv)
                .directory(toolchain.root().toFile())
                .redirectErrorStream(true);
        applyEnvironment(builder.environment(), config);

        log.info("开始构建 workspace={} 命令: {}", workspace.name(), commandLine);

        try {
            Process process = builder.start();
            StringBuilder captured = new StringBuilder();
            Process running = process;
            Thread reader = Thread.ofVirtual().start(() -> {
                try (BufferedReader in = new BufferedReader(
                        new InputStreamReader(running.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) {
                        captured.append(ANSI.matcher(line).replaceAll("")).append('\n');
                    }
                } catch (IOException ex) {
                    log.debug("读取构建输出中断: {}", ex.getMessage());
                }
            });

            boolean finished = process.waitFor(config.timeout().toMillis(), TimeUnit.MILLISECONDS);
            long duration = System.currentTimeMillis() - started;

            if (!finished) {
                process.destroy();
                if (!process.waitFor(3, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
                return new ProcessOutcome(commandLine, null, duration, captured.toString(),
                        true, false, null);
            }

            reader.join(2000);
            return new ProcessOutcome(commandLine, process.exitValue(), duration,
                    captured.toString(), false, false, null);

        } catch (IOException ex) {
            log.warn("启动构建进程失败: {}", ex.getMessage());
            return new ProcessOutcome(commandLine, null, System.currentTimeMillis() - started,
                    "", false, false, ex.getMessage());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return new ProcessOutcome(commandLine, null, System.currentTimeMillis() - started,
                    "", false, true, null);
        }
    }

    // ------------------------------------------------------------ 编译诊断解析

    private List<CompileIssue> parseIssues(String raw, Path root) {
        List<CompileIssue> issues = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        String rootPath = root.toAbsolutePath().toString();
        for (String line : raw.split("\r?\n")) {
            if (issues.size() >= MAX_ISSUES) {
                break;
            }
            Matcher matcher = ISSUE.matcher(line);
            if (!matcher.find()) {
                continue;
            }
            String file = relativize(matcher.group(1), rootPath);
            Integer lineNo = number(matcher.group(2) != null ? matcher.group(2) : matcher.group(4));
            Integer column = number(matcher.group(3));
            String severity = matcher.group(5) == null ? "error" : matcher.group(5);
            String message = matcher.group(6) == null ? "" : matcher.group(6).trim();
            String key = file + ':' + lineNo + ':' + message;
            if (!seen.add(key)) {
                continue;
            }
            issues.add(new CompileIssue(file, lineNo, column, message, severity));
        }
        return issues;
    }

    // ------------------------------------------------------------ 测试结果解析

    /** 取最后一次出现的 surefire 聚合统计（逐模块跑时最后一行是总计）。 */
    private static TestRunResult.Totals parseTotals(String raw) {
        Matcher matcher = SUREFIRE_TOTALS.matcher(raw == null ? "" : raw);
        TestRunResult.Totals totals = null;
        while (matcher.find()) {
            totals = new TestRunResult.Totals(
                    Integer.parseInt(matcher.group(1)),
                    Integer.parseInt(matcher.group(2)),
                    Integer.parseInt(matcher.group(3)),
                    matcher.group(4) == null ? null : Integer.parseInt(matcher.group(4)));
        }
        return totals;
    }

    private List<TestRunResult.TestFailure> parseTestFailures(String raw) {
        Set<String> seen = new LinkedHashSet<>();
        List<TestRunResult.TestFailure> failures = new ArrayList<>();
        if (raw == null || raw.isEmpty()) {
            return failures;
        }
        // 1) 带行号的失败断言（信息最完整，优先）
        Matcher withLine = SUREFIRE_FAILURE.matcher(raw);
        while (withLine.find() && failures.size() < MAX_TEST_FAILURES) {
            String key = withLine.group(1) + '.' + withLine.group(2);
            if (seen.add(key)) {
                failures.add(new TestRunResult.TestFailure(withLine.group(1), withLine.group(2),
                        number(withLine.group(3)), abbreviate(withLine.group(4))));
            }
        }
        // 2) 只有类.方法 + Time elapsed 的行（补充 1) 没覆盖到的用例）
        Matcher elapsed = SUREFIRE_ELAPSED.matcher(raw);
        while (elapsed.find() && failures.size() < MAX_TEST_FAILURES) {
            String key = elapsed.group(1) + '.' + elapsed.group(2);
            if (seen.add(key)) {
                failures.add(new TestRunResult.TestFailure(elapsed.group(1), elapsed.group(2),
                        null, elapsed.group(3) + "：断言或用例执行失败，详见输出尾部"));
            }
        }
        // 3) Gradle 风格：类 > 方法 FAILED
        Matcher gradle = GRADLE_FAILURE.matcher(raw);
        while (gradle.find() && failures.size() < MAX_TEST_FAILURES) {
            String key = gradle.group(1) + '.' + gradle.group(2);
            if (seen.add(key)) {
                failures.add(new TestRunResult.TestFailure(gradle.group(1), gradle.group(2),
                        null, "用例执行失败，详见输出尾部"));
            }
        }
        return failures;
    }

    private static String buildTestNote(int exitCode, TestRunResult.Totals totals,
                                        List<TestRunResult.TestFailure> failures,
                                        List<CompileIssue> issues) {
        if (exitCode == 0) {
            if (totals == null || totals.run() == 0) {
                return "测试通过（构建工具未报告用例统计 —— 可能没有任何测试）。";
            }
            return "测试全部通过：共 " + totals.run() + " 个用例，"
                    + totals.failures() + " 失败 / " + totals.errors() + " 错误。";
        }
        if (totals != null && totals.run() > 0) {
            return "测试失败：共 " + totals.run() + " 个用例，"
                    + totals.failures() + " 失败 / " + totals.errors() + " 错误。";
        }
        if (!issues.isEmpty()) {
            // 典型场景：补丁改了主代码签名，测试代码还没跟上，surefire 根本没跑。
            return "测试代码编译不过（共 " + issues.size() + " 条诊断），测试套件没有执行 —— "
                    + "先修编译错误，测试结果才有意义。";
        }
        return "测试失败（退出码 " + exitCode + "），解析出 " + failures.size() + " 个失败用例。";
    }

    private static String abbreviate(String message) {
        if (message == null) {
            return "";
        }
        String trimmed = message.trim();
        return trimmed.length() > 300 ? trimmed.substring(0, 300) + "…" : trimmed;
    }

    // ------------------------------------------------------------ 公共工具

    /** 项目自带 wrapper 的绝对路径（存在且可执行时）。 */
    private java.util.Optional<String> wrapper(Path root, String name) {
        Path candidate = root.resolve(isWindows() ? name + ".bat" : name);
        if (Files.isRegularFile(candidate)) {
            return java.util.Optional.of(candidate.toAbsolutePath().toString());
        }
        Path plain = root.resolve(name);
        return Files.isRegularFile(plain)
                ? java.util.Optional.of(plain.toAbsolutePath().toString())
                : java.util.Optional.empty();
    }

    /**
     * 在 PATH 上找出可执行文件。
     *
     * <p>必须自己找而不是直接把 {@code mvn} 交给 ProcessBuilder：Windows 上真正的文件叫
     * {@code mvn.cmd}，而 CreateProcess 不会去套用 PATHEXT 扩展名，直接执行会报「找不到文件」。
     */
    private String resolveExecutable(String command) {
        if (command == null || command.isBlank()) {
            return null;
        }
        String trimmed = command.trim();
        if (trimmed.contains("/") || trimmed.contains("\\")) {
            return Files.isRegularFile(Path.of(trimmed)) ? trimmed : null;
        }
        Set<String> names = candidateNames(trimmed);
        String path = System.getenv("PATH");
        if (path == null) {
            return null;
        }
        for (String dir : path.split(Pattern.quote(File.pathSeparator))) {
            if (dir.isBlank()) {
                continue;
            }
            for (String name : names) {
                Path candidate = Path.of(dir, name);
                if (Files.isRegularFile(candidate)) {
                    return candidate.toAbsolutePath().toString();
                }
            }
        }
        return null;
    }

    /**
     * 按平台生成候选文件名。
     *
     * <p>Windows 上**必须先试带扩展名的**，这不是排列口味问题：Maven / Gradle 的 {@code bin}
     * 目录里同时放着给 Unix 用的**无扩展名 shell 脚本**（{@code mvn}）和给 Windows 用的
     * {@code mvn.cmd}。按「先试裸名」的顺序会命中那个 shell 脚本 —— 它确实是普通文件，
     * {@code isRegularFile} 返回 true，然后 CreateProcess 直接报
     * {@code error=193, %1 不是有效的 Win32 应用程序}，编译闭环整个失效。
     */
    private static Set<String> candidateNames(String base) {
        Set<String> names = new java.util.LinkedHashSet<>();
        if (isWindows()) {
            String lower = base.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".exe")) {
                names.add(base);
                return names;
            }
            names.add(base + ".cmd");
            names.add(base + ".exe");
            names.add(base + ".bat");
        }
        names.add(base);
        return names;
    }

    private void applyEnvironment(Map<String, String> env, AppProperties.Compile config) {
        String javaHome = config.javaHome() == null ? "" : config.javaHome().trim();
        if (!javaHome.isEmpty() && Files.isDirectory(Path.of(javaHome))) {
            env.put("JAVA_HOME", javaHome);
            String bin = javaHome + File.separator + "bin";
            // Windows 的 PATH 在注册表里叫 "Path"，而 ProcessBuilder.environment() 是
            // 大小写敏感的 HashMap（JDK 源码 ProcessEnvironment extends HashMap）。
            // 直接 env.put("PATH", ...) 会在保留 "Path" 的同时再塞一个只剩 JDK bin 的
            // "PATH"，子进程的 PATH 由此被污染 —— mvn.cmd 尾部的 `cmd /C exit /B` 找不到
            // 裸名 cmd，BUILD SUCCESS 也会拿到退出码 1。必须找到原键原位更新。
            String pathKey = env.keySet().stream()
                    .filter(k -> k.equalsIgnoreCase("PATH"))
                    .findFirst()
                    .orElse("PATH");
            String path = env.getOrDefault(pathKey, "");
            env.put(pathKey, bin + File.pathSeparator + path);
        }
        // 统一成 UTF-8 输出：Windows 默认 GBK 会让中文注释变成乱码，喂回模型只会更糟
        env.merge("MAVEN_OPTS",
                "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8",
                (old, add) -> old + " " + add);
        env.merge("GRADLE_OPTS",
                "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8",
                (old, add) -> old + " " + add);
    }

    private static String relativize(String file, String rootPath) {
        String normalized = file.replace('\\', '/');
        String normalizedRoot = rootPath.replace('\\', '/');
        if (normalized.startsWith(normalizedRoot)) {
            normalized = normalized.substring(normalizedRoot.length());
        }
        while (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        return normalized;
    }

    private static Integer number(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Integer.valueOf(value.trim());
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    /** 输出保留尾部：错误和结论总在末尾，前面的进度信息价值最低。 */
    private static String trim(String text, int maxChars) {
        if (text == null) {
            return "";
        }
        if (text.length() <= maxChars) {
            return text;
        }
        String tail = text.substring(text.length() - maxChars);
        int newline = tail.indexOf('\n');
        if (newline > 0 && newline < 200) {
            tail = tail.substring(newline + 1);
        }
        return "…（前面 " + (text.length() - tail.length()) + " 字符的输出已省略）\n" + tail;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }
}
