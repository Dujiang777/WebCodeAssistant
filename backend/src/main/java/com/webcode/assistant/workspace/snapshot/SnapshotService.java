package com.webcode.assistant.workspace.snapshot;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.workspace.IgnoreRules;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream;
import org.apache.commons.compress.archivers.zip.ZipFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 工作区快照：把工作区（过滤忽略目录后）打成 zip 存到 {@code data/snapshots/ws-{id}/}，
 * 支持随时回滚到任意时点。
 *
 * <p><b>为什么存 zip 而不是把文件内容进数据库</b>：快照的价值是「整个工作区的原样副本」，
 * 二进制文件、深层目录结构都要保真 —— 文件系统 + zip 是最不容易出错的存储；
 * 数据库只存元数据（谁、何时、为什么、多少文件）。
 *
 * <p><b>自动打点的时机</b>：每次应用补丁之前（由 {@code PatchService} 调用）。
 * 打点失败就终止应用 —— 「没有安全网的写入」和「谎报成功的检查」是同一种错误。
 *
 * <p><b>回滚语义是真·时点恢复</b>：先删掉快照里没有的文件（忽略目录里的构建产物不动，
 * 它们可再生），再解包快照。这样回滚后不会残留「快照之后新增」的文件。
 */
@Service
public class SnapshotService {

    private static final Logger log = LoggerFactory.getLogger(SnapshotService.class);

    /** 每个工作区保留的自动快照上限，超出淘汰最旧的（手动快照不受影响）。 */
    private static final int MAX_AUTO_SNAPSHOTS = 15;

    private static final String ZIP_ENTRY_SEPARATOR = "/";

    private final SnapshotRepository snapshotRepository;
    private final WorkspaceService workspaceService;
    private final AppProperties properties;

    public SnapshotService(SnapshotRepository snapshotRepository,
                           WorkspaceService workspaceService,
                           AppProperties properties) {
        this.snapshotRepository = snapshotRepository;
        this.workspaceService = workspaceService;
        this.properties = properties;
    }

    // ------------------------------------------------------------ 视图

    /** 快照的对外视图。 */
    public record SnapshotView(UUID id, String kind, String label, UUID patchId,
                               int fileCount, long sizeBytes, String createdAt) {

        public static SnapshotView of(Snapshot snapshot) {
            return new SnapshotView(snapshot.id(), snapshot.kind(), snapshot.label(),
                    snapshot.patchId(), snapshot.fileCount(), snapshot.sizeBytes(),
                    snapshot.createdAt().toString());
        }
    }

    // ------------------------------------------------------------ 创建

    /**
     * 创建快照。失败抛异常 —— 调用方（补丁应用）靠它保证「不留下没有快照的写入」。
     */
    public SnapshotView create(Workspace workspace, long userId, String kind, String label, UUID patchId) {
        Path root = workspaceService.rootOf(workspace);
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "工作区目录不存在，无法快照");
        }

        UUID id = UUID.randomUUID();
        Path zipPath = zipPathOf(workspace.id(), id);
        try {
            Files.createDirectories(zipPath.getParent());
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "创建快照目录失败: " + ex.getMessage(), ex);
        }

        int fileCount;
        try {
            fileCount = writeZip(root, zipPath);
        } catch (IOException | RuntimeException ex) {
            quietDelete(zipPath);
            if (ex instanceof ApiException apiException) {
                throw apiException;
            }
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "快照打包失败: " + ex.getMessage(), ex);
        }

        long zipBytes;
        try {
            zipBytes = Files.size(zipPath);
        } catch (IOException ex) {
            quietDelete(zipPath);
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取快照体积失败", ex);
        }

        try {
            snapshotRepository.insert(id, workspace.id(), userId, kind, label, patchId, fileCount, zipBytes);
        } catch (RuntimeException ex) {
            quietDelete(zipPath);
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "快照元数据写入失败: " + ex.getMessage(), ex);
        }
        log.info("快照已创建 workspace={} kind={} 文件数={} zip={} bytes", workspace.id(), kind, fileCount, zipBytes);

        if (Snapshot.KIND_AUTO.equals(kind)) {
            pruneAutoSnapshots(workspace.id());
        }
        return snapshotRepository.findById(id).map(SnapshotView::of).orElseThrow();
    }

    /** 递归打包：跳过忽略目录，条目名为相对路径（统一 / 分隔）。返回文件数。 */
    private int writeZip(Path root, Path zipPath) throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).forEach(files::add);
        }
        int count = 0;
        try (ZipArchiveOutputStream zip = new ZipArchiveOutputStream(zipPath.toFile())) {
            zip.setEncoding("UTF-8");
            for (Path file : files) {
                String relative = root.relativize(file).toString().replace('\\', ZIP_ENTRY_SEPARATOR.charAt(0));
                if (isIgnoredRelativePath(relative)) {
                    continue;
                }
                if (++count > properties.maxArchiveEntries()) {
                    throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE,
                            "工作区文件数超过快照上限 " + properties.maxArchiveEntries());
                }
                ZipArchiveEntry entry = new ZipArchiveEntry(relative);
                zip.putArchiveEntry(entry);
                try (InputStream in = Files.newInputStream(file)) {
                    in.transferTo(zip);
                }
                zip.closeArchiveEntry();
            }
        }
        return count;
    }

    /** 相对路径是否落在忽略目录里（忽略目录整体不进快照、回滚时也不清空）。 */
    private boolean isIgnoredRelativePath(String relative) {
        String[] segments = relative.split(ZIP_ENTRY_SEPARATOR);
        for (int i = 0; i < segments.length - 1; i++) {
            if (IgnoreRules.isIgnoredDirectory(segments[i])) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ 查询 / 删除

    public List<SnapshotView> list(long userId, long workspaceId) {
        workspaceService.require(userId, workspaceId);
        return snapshotRepository.findByWorkspace(workspaceId).stream().map(SnapshotView::of).toList();
    }

    public void delete(long userId, long workspaceId, UUID snapshotId) {
        workspaceService.require(userId, workspaceId);
        Snapshot snapshot = requireInWorkspace(snapshotId, workspaceId);
        snapshotRepository.delete(snapshotId);
        quietDelete(zipPathOf(workspaceId, snapshot.id()));
        log.info("快照已删除 workspace={} snapshot={}", workspaceId, snapshotId);
    }

    // ------------------------------------------------------------ 回滚

    /**
     * 回滚：删除快照之外的文件 → 解包快照 → 刷新体积。
     *
     * <p>安全护栏：zip 条目路径全部过 Zip Slip 校验（复用 ZipImportService 的思路）；
     * 解包总量受 {@code app.max-workspace-bytes} 约束；符号链接条目跳过。
     */
    public SnapshotView restore(long userId, long workspaceId, UUID snapshotId) {
        Workspace workspace = workspaceService.require(userId, workspaceId);
        Snapshot snapshot = requireInWorkspace(snapshotId, workspaceId);
        Path zipPath = zipPathOf(workspaceId, snapshot.id());
        if (!Files.isRegularFile(zipPath)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "快照文件已丢失，无法回滚（可能被手工清理）");
        }

        Path root = workspaceService.rootOf(workspace).toAbsolutePath().normalize();
        Set<String> entries = new HashSet<>();

        // 第一步：删除快照里没有的文件（忽略目录里的构建产物保留 —— 它们可再生且不进快照）
        try (ZipFile zip = ZipFile.builder().setPath(zipPath).get()) {
            Enumeration<ZipArchiveEntry> all = zip.getEntries();
            while (all.hasMoreElements()) {
                ZipArchiveEntry entry = all.nextElement();
                if (!entry.isDirectory() && !entry.isUnixSymlink()) {
                    entries.add(normalizeEntryName(entry.getName()));
                }
            }
            deleteFilesNotInSnapshot(root, entries);
            deleteEmptyDirectories(root);

            // 第二步：解包覆盖
            long total = 0;
            Enumeration<ZipArchiveEntry> rest = zip.getEntries();
            while (rest.hasMoreElements()) {
                ZipArchiveEntry entry = rest.nextElement();
                if (entry.isUnixSymlink()) {
                    continue;
                }
                Path destination = resolveEntry(root, entry.getName());
                if (destination == null) {
                    continue;
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(destination);
                    continue;
                }
                Files.createDirectories(destination.getParent());
                long written = copyBounded(zip.getInputStream(entry), destination,
                        properties.maxWorkspaceBytes() - total);
                total += written;
            }
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "回滚失败: " + ex.getMessage(), ex);
        }

        workspaceService.refreshSize(workspace);
        log.info("工作区已回滚 workspace={} snapshot={} 恢复文件数={}", workspaceId, snapshotId, entries.size());
        return SnapshotView.of(snapshot);
    }

    private void deleteFilesNotInSnapshot(Path root, Set<String> snapshotEntries) throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path file : walk.filter(Files::isRegularFile).toList()) {
                String relative = root.relativize(file).toString().replace('\\', ZIP_ENTRY_SEPARATOR.charAt(0));
                if (isIgnoredRelativePath(relative)) {
                    continue;
                }
                if (!snapshotEntries.contains(relative)) {
                    Files.deleteIfExists(file);
                }
            }
        }
    }

    private void deleteEmptyDirectories(Path root) throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path dir : walk.filter(Files::isDirectory).sorted(Comparator.reverseOrder()).toList()) {
                if (dir.equals(root) || IgnoreRules.isIgnoredDirectory(dir)) {
                    continue;
                }
                try (Stream<Path> children = Files.list(dir)) {
                    if (children.findAny().isEmpty()) {
                        Files.deleteIfExists(dir);
                    }
                }
            }
        }
    }

    /** 与 ZipImportService 一致的 Zip Slip 防护；返回 null 表示跳过该条目。 */
    private Path resolveEntry(Path normalizedTarget, String rawName) {
        if (rawName == null || rawName.isBlank()) {
            return null;
        }
        String name = rawName.replace('\\', ZIP_ENTRY_SEPARATOR.charAt(0));
        if (name.startsWith("/") || name.matches("^[A-Za-z]:.*")) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "快照内存在绝对路径条目: " + rawName);
        }
        Path destination = normalizedTarget.resolve(name).normalize();
        if (!destination.startsWith(normalizedTarget)) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "快照内路径越界: " + rawName);
        }
        return destination;
    }

    private String normalizeEntryName(String rawName) {
        return rawName.replace('\\', ZIP_ENTRY_SEPARATOR.charAt(0));
    }

    private long copyBounded(InputStream in, Path destination, long remainingBudget) throws IOException {
        long written = 0;
        byte[] buffer = new byte[64 * 1024];
        try (OutputStream out = Files.newOutputStream(destination)) {
            int read;
            while ((read = in.read(buffer)) > 0) {
                written += read;
                if (written > remainingBudget) {
                    throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE, "快照解包体积超过工作区上限");
                }
                out.write(buffer, 0, read);
            }
        }
        return written;
    }

    // ------------------------------------------------------------ 内部工具

    private Snapshot requireInWorkspace(UUID snapshotId, long workspaceId) {
        Snapshot snapshot = snapshotRepository.findById(snapshotId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "快照不存在"));
        if (snapshot.workspaceId() != workspaceId) {
            throw new ApiException(ErrorCode.NOT_FOUND, "快照不属于该工作区");
        }
        return snapshot;
    }

    /** 快照存储根：与工作区根同级，避免混进工作区目录树被 grep / 索引扫到。 */
    private Path snapshotsRoot() {
        Path workspaceRoot = Path.of(properties.workspaceRoot()).toAbsolutePath().normalize();
        Path parent = workspaceRoot.getParent() == null ? workspaceRoot : workspaceRoot.getParent();
        return parent.resolve("snapshots");
    }

    private Path zipPathOf(long workspaceId, UUID snapshotId) {
        return snapshotsRoot().resolve("ws-" + workspaceId).resolve(snapshotId + ".zip");
    }

    private void pruneAutoSnapshots(long workspaceId) {
        List<Snapshot> autos = snapshotRepository.findAutoByWorkspace(workspaceId);
        if (autos.size() <= MAX_AUTO_SNAPSHOTS) {
            return;
        }
        for (Snapshot stale : autos.subList(MAX_AUTO_SNAPSHOTS, autos.size())) {
            snapshotRepository.delete(stale.id());
            quietDelete(zipPathOf(workspaceId, stale.id()));
        }
    }

    private void quietDelete(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ex) {
            log.warn("清理快照文件失败: {}", path, ex);
        }
    }
}
