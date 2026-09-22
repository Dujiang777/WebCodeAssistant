package com.webcode.assistant.terminal;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.workspace.Workspace;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * 网页终端（功能 12）：让登录用户在工作区里手动跑命令（mvn test、git status、node …）。
 *
 * <p><b>安全模型 —— 先说清楚它不是什么</b>：这不是给模型的工具。AgentToolbox 里
 * 永远不会有 run_command；「模型不能执行命令」是从第一天守到现在的红线。
 * 这个终端只由登录用户在前端手动触发，等价于用户自己开一个 cd 到工作区的控制台，
 * 差别只在路径锁定与下面的限制。
 *
 * <p>本地没有 Docker（V2 沙箱方案的前置条件）时的降级实现，四道护栏：
 * <ol>
 *   <li><b>cwd 锁定工作区根</b>：进程工作目录固定为该用户的工作区，且先校验归属；</li>
 *   <li><b>拒绝 shell 元字符</b>：{@code & | > < ; ^ % ` $(} 一律拒绝 —— 没有管道、
 *       重定向和命令链，命令的危害就被限制在「单个程序 + 它的参数」里；</li>
 *   <li><b>超时杀进程</b>：默认 120 秒，到点 destroyForcibly；</li>
 *   <li><b>输出截断</b>：最多保留 64KB，防止 cat 大文件刷爆内存与前端。</li>
 * </ol>
 */
@Service
public class TerminalService {

    private static final Logger log = LoggerFactory.getLogger(TerminalService.class);

    /** 长度上限：命令串不可能合理地超过 500 字符。 */
    private static final int MAX_COMMAND_LENGTH = 500;

    /**
     * shell 元字符与危险序列。cmd.exe 下这些字符要么改变命令结构（管道/链接/重定向），
     * 要么展开环境变量 / 子命令（%VAR%、$(…)、反引号），都必须挡掉。
     */
    private static final String FORBIDDEN = "&|<>;^%`$";

    private final AppProperties properties;

    public TerminalService(AppProperties properties) {
        this.properties = properties;
    }

    /**
     * 在工作区根目录执行一条命令并等待结束。
     */
    public TerminalResult run(Workspace workspace, String rawCommand) {
        AppProperties.Terminal config = properties.terminal();
        if (!config.enabled()) {
            throw new ApiException(ErrorCode.FORBIDDEN, "终端功能已禁用（TERMINAL_ENABLED=false）");
        }
        String command = sanitize(rawCommand);
        Path root = Files.isDirectory(Path.of(workspace.rootPath()))
                ? Path.of(workspace.rootPath()).toAbsolutePath().normalize()
                : null;
        if (root == null) {
            throw new ApiException(ErrorCode.NOT_FOUND, "工作区目录不存在");
        }

        long start = System.nanoTime();
        Process process;
        try {
            process = new ProcessBuilder("cmd.exe", "/c", command)
                    .directory(root.toFile())
                    .redirectErrorStream(true)
                    .start();
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "无法启动命令进程: " + ex.getMessage(), ex);
        }

        boolean timedOut = false;
        StringBuilder output = new StringBuilder();
        try (InputStream in = process.getInputStream()) {
            // 边读边收：进程可能先写满缓冲区再退出，必须持续消费否则会死锁
            Thread reader = Thread.ofVirtual().start(() -> {
                byte[] buf = new byte[8 * 1024];
                try {
                    int read;
                    while ((read = in.read(buf)) > 0) {
                        synchronized (output) {
                            if (output.length() < config.maxOutputChars()) {
                                output.append(new String(buf, 0, read, charsetOf()));
                            }
                        }
                    }
                } catch (IOException ignored) {
                    // 进程被杀时流会异常关闭 —— 属预期
                }
            });

            boolean finished = process.waitFor(config.timeout().toSeconds(), TimeUnit.SECONDS);
            if (!finished) {
                timedOut = true;
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
            reader.join(2000);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取命令输出失败: " + ex.getMessage(), ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "命令执行被中断");
        }

        long durationMs = (System.nanoTime() - start) / 1_000_000;
        String text;
        boolean truncated;
        synchronized (output) {
            truncated = output.length() > config.maxOutputChars();
            text = truncated ? output.substring(0, config.maxOutputChars()) : output.toString();
        }
        Integer exitCode = timedOut ? null : safeExit(process);
        log.info("终端命令 workspace={} 时长={}ms 退出码={} 超时={}", workspace.id(), durationMs, exitCode, timedOut);
        return new TerminalResult(command, exitCode, durationMs, text, timedOut, truncated);
    }

    /** 校验并清理命令串。 */
    private String sanitize(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "命令不能为空");
        }
        String command = raw.trim();
        if (command.length() > MAX_COMMAND_LENGTH) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "命令长度超过 " + MAX_COMMAND_LENGTH + " 字符");
        }
        for (char ch : command.toCharArray()) {
            if (ch < 0x20 || FORBIDDEN.indexOf(ch) >= 0) {
                throw new ApiException(ErrorCode.BAD_REQUEST,
                        "命令包含不允许的字符 " + describe(ch) + " —— 终端不支持管道 / 重定向 / 命令链");
            }
        }
        return command;
    }

    private String describe(char ch) {
        return switch (ch) {
            case '\n' -> "换行";
            case '\t' -> "制表符";
            case '\r' -> "回车";
            default -> "'" + ch + "'";
        };
    }

    private Integer safeExit(Process process) {
        try {
            return process.exitValue();
        } catch (IllegalThreadStateException ex) {
            return null;
        }
    }

    private Charset charsetOf() {
        // Windows 中文环境的控制台输出默认是 GBK 代码页；其他平台按 UTF-8 处理
        if (System.getProperty("os.name", "").toLowerCase().contains("win")) {
            try {
                return Charset.forName("GBK");
            } catch (Exception ex) {
                return Charset.defaultCharset();
            }
        }
        return StandardCharsets.UTF_8;
    }
}
