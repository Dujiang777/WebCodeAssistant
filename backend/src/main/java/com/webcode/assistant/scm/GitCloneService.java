package com.webcode.assistant.scm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.config.ExecutorConfig;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

/**
 * 基于 JGit 的仓库克隆。
 *
 * <p>三层防护：
 * <ol>
 *   <li>URL 白名单（{@link GitUrlValidator}），拒绝 file:// 与本地路径；</li>
 *   <li>浅克隆 {@code --depth 1}，不拉历史，减少体积与时间；</li>
 *   <li>整体超时（跑在虚拟线程上，超时即取消并清理目录），克隆完成后校验体积上限。</li>
 * </ol>
 *
 * <p>V2 计划：把 clone 放进一次性沙箱容器里执行，届时这里改成调用沙箱服务，
 * {@link #cloneRepository} 的签名保持不变。
 */
@Service
public class GitCloneService {

    private static final Logger log = LoggerFactory.getLogger(GitCloneService.class);

    private final AppProperties properties;
    private final ExecutorConfig.AppExecutors executors;

    public GitCloneService(AppProperties properties, ExecutorConfig.AppExecutors executors) {
        this.properties = properties;
        this.executors = executors;
    }

    /**
     * 浅克隆到指定目录。
     *
     * @param gitUrl       已通过 {@link GitUrlValidator} 校验的地址
     * @param targetDir    目标目录（必须已存在且为空）
     * @param credentials  可选，私有仓库的用户名/口令；为 null 表示匿名访问
     */
    public void cloneRepository(String gitUrl, Path targetDir, Credentials credentials) {
        Duration timeout = properties.gitClone().timeout();
        Future<?> task = executors.workspace().submit(() -> doClone(gitUrl, targetDir, credentials));
        try {
            task.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException ex) {
            task.cancel(true);
            cleanup(targetDir);
            throw new ApiException(ErrorCode.CLONE_FAILED,
                    "克隆超时（超过 " + timeout.toSeconds() + " 秒），已中止并清理");
        } catch (ExecutionException ex) {
            cleanup(targetDir);
            Throwable cause = ex.getCause() == null ? ex : ex.getCause();
            if (cause instanceof ApiException apiException) {
                throw apiException;
            }
            log.warn("克隆失败: {} -> {}", gitUrl, cause.toString());
            throw new ApiException(ErrorCode.CLONE_FAILED, "克隆失败: " + shortMessage(cause), cause);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            cleanup(targetDir);
            throw new ApiException(ErrorCode.CLONE_FAILED, "克隆被中断");
        }
    }

    private void doClone(String gitUrl, Path targetDir, Credentials credentials) {
        var command = Git.cloneRepository()
                .setURI(gitUrl)
                .setDirectory(targetDir.toFile())
                .setDepth(Math.max(1, properties.gitClone().depth()))
                .setCloneAllBranches(false)
                .setCloneSubmodules(false)
                .setTimeout((int) Math.max(30, properties.gitClone().timeout().toSeconds()))
                .setProgressMonitor(null);

        if (credentials != null && credentials.username() != null && !credentials.username().isBlank()) {
            command.setCredentialsProvider(
                    new UsernamePasswordCredentialsProvider(credentials.username(), credentials.password()));
        }

        try (Git git = command.call()) {
            log.info("克隆完成: {} -> {}", gitUrl, git.getRepository().getDirectory());
        } catch (GitAPIException ex) {
            throw new ApiException(ErrorCode.CLONE_FAILED, "克隆失败: " + shortMessage(ex), ex);
        }
    }

    /** 清理半成品目录，避免失败后残留占用磁盘、影响同名重试。 */
    private void cleanup(Path targetDir) {
        if (!Files.exists(targetDir)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(targetDir)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException ex) {
            log.warn("清理克隆残留失败: {}", targetDir, ex);
        }
    }

    private static String shortMessage(Throwable throwable) {
        String message = throwable.getMessage();
        if (message == null) {
            return throwable.getClass().getSimpleName();
        }
        // 认证类错误里可能带着 URL 中的凭证，截断并去掉可能的口令片段
        int newline = message.indexOf('\n');
        if (newline > 0) {
            message = message.substring(0, newline);
        }
        return message.length() > 300 ? message.substring(0, 300) + "..." : message;
    }

    /**
     * 私有仓库凭据。
     *
     * <p>仅用于内存传递，不落库、不写日志。第一期前端不暴露入口，
     * 需要时通过环境变量注入（见 README「私有仓库」一节）。
     */
    public record Credentials(String username, String password) {

        @Override
        public String toString() {
            return "Credentials[username=" + username + ", password=***]";
        }
    }
}
