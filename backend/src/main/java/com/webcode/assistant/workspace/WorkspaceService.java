package com.webcode.assistant.workspace;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.config.ExecutorConfig;
import com.webcode.assistant.scm.GitCloneService;
import com.webcode.assistant.scm.GitUrlValidator;
import com.webcode.assistant.scm.SampleProjectService;
import com.webcode.assistant.scm.ZipImportService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

/**
 * 工作区生命周期编排：目录分配、克隆 / 解压 / 内置样例导入、归属校验。
 *
 * <p>目录布局：{@code {workspaceRoot}/{userId}/{uuid}-{slug}/}
 * —— 以 userId 分桶便于将来做单用户配额；uuid 保证同名仓库不冲突。
 */
@Service
public class WorkspaceService {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceService.class);
    private static final long IMPORT_TIMEOUT_SECONDS = 300;

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceFileService fileService;
    private final WorkspacePathResolver pathResolver;
    private final GitCloneService gitCloneService;
    private final ZipImportService zipImportService;
    private final SampleProjectService sampleProjectService;
    private final AppProperties properties;
    private final ExecutorConfig.AppExecutors executors;

    public WorkspaceService(WorkspaceRepository workspaceRepository,
                            WorkspaceFileService fileService,
                            WorkspacePathResolver pathResolver,
                            GitCloneService gitCloneService,
                            ZipImportService zipImportService,
                            SampleProjectService sampleProjectService,
                            AppProperties properties,
                            ExecutorConfig.AppExecutors executors) {
        this.workspaceRepository = workspaceRepository;
        this.fileService = fileService;
        this.pathResolver = pathResolver;
        this.gitCloneService = gitCloneService;
        this.zipImportService = zipImportService;
        this.sampleProjectService = sampleProjectService;
        this.properties = properties;
        this.executors = executors;
    }

    @Transactional(readOnly = true)
    public List<Workspace> list(long userId) {
        return workspaceRepository.findAllByUser(userId);
    }

    /** 读取并做归属校验；查不到一律 404，不泄露「存在但不属于你」。 */
    @Transactional(readOnly = true)
    public Workspace require(long userId, long workspaceId) {
        return workspaceRepository.findOwned(workspaceId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "工作区不存在或无权访问"));
    }

    public Path rootOf(Workspace workspace) {
        return pathResolver.rootOf(workspace.rootPath());
    }

    /** 从 Git 地址创建。 */
    public Workspace createFromGit(long userId, String requestedName, String gitUrl) {
        String url = GitUrlValidator.validateAndNormalize(gitUrl);
        String name = resolveName(requestedName, GitUrlValidator.suggestName(url));
        Path directory = allocateDirectory(userId, name);
        try {
            gitCloneService.cloneRepository(url, directory, null);
            long size = fileService.computeSize(directory);
            assertSizeWithinLimit(size);
            long id = workspaceRepository.insert(userId, name, directory.toString(), url, size);
            log.info("工作区已创建(#{}) userId={} name={}", id, userId, name);
            return require(userId, id);
        } catch (RuntimeException ex) {
            deleteRecursively(directory);
            throw ex;
        }
    }

    /** 从上传的 zip 创建。 */
    public Workspace createFromArchive(long userId, String requestedName, String originalFilename, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "请选择要上传的 zip 文件");
        }
        String filename = originalFilename == null ? "archive.zip" : originalFilename;
        if (!filename.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) {
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "仅支持 .zip 压缩包");
        }

        String base = filename.substring(0, filename.length() - 4);
        String name = resolveName(requestedName, base);
        Path root = pathResolver.rootOf(properties.workspaceRoot());

        Path staging = root.resolve(".staging").resolve(UUID.randomUUID() + ".zip");
        Path directory = allocateDirectory(userId, name);
        try {
            Files.createDirectories(staging.getParent());
            try (var in = file.getInputStream()) {
                Files.copy(in, staging, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            runWithTimeout(() -> zipImportService.extract(staging, directory), "解压超时");

            long size = fileService.computeSize(directory);
            assertSizeWithinLimit(size);
            long id = workspaceRepository.insert(userId, name, directory.toString(), null, size);
            log.info("工作区已创建(#{}) userId={} name={} (zip)", id, userId, name);
            return require(userId, id);
        } catch (IOException ex) {
            deleteRecursively(directory);
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "保存上传文件失败: " + ex.getMessage(), ex);
        } catch (RuntimeException ex) {
            deleteRecursively(directory);
            throw ex;
        } finally {
            try {
                Files.deleteIfExists(staging);
            } catch (IOException ex) {
                log.debug("清理临时上传文件失败: {}", staging, ex);
            }
        }
    }

    /** 用内置样例项目创建，便于在没有网络 / 没有 Git 仓库时也能完整演示。 */
    public Workspace createFromSample(long userId, String requestedName) {
        String name = resolveName(requestedName, SampleProjectService.SAMPLE_NAME);
        Path directory = allocateDirectory(userId, name);
        try {
            sampleProjectService.materialize(directory);
            long size = fileService.computeSize(directory);
            assertSizeWithinLimit(size);
            long id = workspaceRepository.insert(userId, name, directory.toString(), null, size);
            log.info("工作区已创建(#{}) userId={} name={} (内置样例)", id, userId, name);
            return require(userId, id);
        } catch (RuntimeException ex) {
            deleteRecursively(directory);
            throw ex;
        }
    }

    /** 重新统计并落库工作区体积（写入 / 应用补丁后调用）。 */
    public void refreshSize(Workspace workspace) {
        workspaceRepository.updateSize(workspace.id(), fileService.computeSize(rootOf(workspace)));
    }

    // ------------------------------------------------------------ 内部工具

    private Path allocateDirectory(long userId, String name) {
        Path root = pathResolver.rootOf(properties.workspaceRoot());
        String slug = name.replaceAll("[^A-Za-z0-9._-]", "-");
        if (slug.length() > 40) {
            slug = slug.substring(0, 40);
        }
        Path directory = root.resolve(Long.toString(userId))
                .resolve(UUID.randomUUID().toString().substring(0, 8) + "-" + slug)
                .normalize();
        if (!directory.startsWith(root)) {
            throw new ApiException(ErrorCode.PATH_ESCAPE, "工作区目录越界");
        }
        try {
            Files.createDirectories(directory);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "创建工作区目录失败: " + ex.getMessage(), ex);
        }
        return directory;
    }

    private String resolveName(String requested, String fallback) {
        String raw = requested == null || requested.isBlank() ? fallback : requested.trim();
        if (raw.isEmpty()) {
            raw = "workspace";
        }
        return raw.length() > 120 ? raw.substring(0, 120) : raw;
    }

    private void assertSizeWithinLimit(long size) {
        if (size > properties.maxWorkspaceBytes()) {
            throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE,
                    "仓库体积 " + (size / 1024 / 1024) + " MB 超过上限 "
                            + (properties.maxWorkspaceBytes() / 1024 / 1024) + " MB");
        }
    }

    private void runWithTimeout(Runnable task, String timeoutMessage) {
        Future<?> future = executors.workspace().submit(task);
        try {
            future.get(IMPORT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException ex) {
            future.cancel(true);
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, timeoutMessage);
        } catch (ExecutionException ex) {
            Throwable cause = ex.getCause() == null ? ex : ex.getCause();
            if (cause instanceof ApiException apiException) {
                throw apiException;
            }
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "导入失败: " + cause.getMessage(), cause);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "导入被中断");
        }
    }

    private void deleteRecursively(Path directory) {
        if (!Files.exists(directory)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(directory)) {
            for (Path path : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException ex) {
            log.warn("清理工作区目录失败: {}", directory, ex);
        }
    }
}
