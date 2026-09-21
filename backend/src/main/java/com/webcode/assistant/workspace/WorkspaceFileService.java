package com.webcode.assistant.workspace;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 工作区文件读写。所有路径都必须先过 {@link WorkspacePathResolver}。
 *
 * <p>约定：
 * <ul>
 *   <li>读取超过 {@code app.max-read-bytes} 时截断，并显式标记 {@code truncated}；</li>
 *   <li>写入使用「临时文件 + 原子替换」，避免进程中断留下半个文件；</li>
 *   <li>每次写入前后都做体积配额检查，配额按工作区总量算而不是单文件算。</li>
 * </ul>
 */
@Service
public class WorkspaceFileService {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceFileService.class);
    private static final int BINARY_SNIFF_BYTES = 8000;
    private static final int MAX_TREE_DEPTH = 32;

    private final WorkspacePathResolver pathResolver;
    private final AppProperties properties;

    public WorkspaceFileService(WorkspacePathResolver pathResolver, AppProperties properties) {
        this.pathResolver = pathResolver;
        this.properties = properties;
    }

    public Path rootOf(Workspace workspace) {
        return pathResolver.rootOf(workspace.rootPath());
    }

    // ------------------------------------------------------------------ 读

    public FileNode tree(Workspace workspace) {
        Path root = rootOf(workspace);
        if (!Files.isDirectory(root)) {
            return FileNode.dir("", workspace.name(), List.of());
        }
        int[] budget = {properties.maxTreeEntries()};
        return buildNode(root, root, "", budget, 0);
    }

    private FileNode buildNode(Path root, Path current, String relativePath, int[] budget, int depth) {
        if (depth > MAX_TREE_DEPTH) {
            return FileNode.dir(relativePath, current.getFileName() == null ? "" : current.getFileName().toString(), List.of());
        }
        List<FileNode> children = new ArrayList<>();
        try (Stream<Path> stream = Files.list(current)) {
            List<Path> entries = stream
                    .filter(path -> !IgnoreRules.isIgnoredDirectory(path))
                    .sorted(Comparator
                            .comparing((Path p) -> Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) ? 0 : 1)
                            .thenComparing(p -> p.getFileName().toString().toLowerCase(java.util.Locale.ROOT)))
                    .toList();

            for (Path entry : entries) {
                if (budget[0] <= 0) {
                    break;
                }
                budget[0]--;
                String childRelative = pathResolver.relativize(root, entry);
                if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
                    children.add(buildNode(root, entry, childRelative, budget, depth + 1));
                } else if (Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)) {
                    children.add(FileNode.file(childRelative, entry.getFileName().toString(), safeSize(entry)));
                }
            }
        } catch (IOException ex) {
            log.warn("读取目录失败: {}", current, ex);
        }
        String name = relativePath.isEmpty() ? "" : current.getFileName().toString();
        return FileNode.dir(relativePath, name, children);
    }

    /**
     * 只列一层目录的直接子项 —— 供 Agent 的 {@code list_dir} 工具使用。
     *
     * <p>与 {@link #tree} 分开是有意为之：在大仓库上构建整棵树再下钻，既慢又浪费内存，
     * 而 Agent 每次都只需要看一层。
     */
    public List<FileNode> listDirectory(Workspace workspace, String relativePath) {
        Path root = rootOf(workspace);
        Path dir = pathResolver.resolve(root, relativePath);
        if (!Files.exists(dir, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "目录不存在: " + relativePath);
        }
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_A_DIRECTORY, "不是目录: " + relativePath);
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return stream
                    .filter(path -> !IgnoreRules.isIgnoredDirectory(path))
                    .sorted(Comparator
                            .comparing((Path p) -> Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) ? 0 : 1)
                            .thenComparing(p -> p.getFileName().toString().toLowerCase(java.util.Locale.ROOT)))
                    .map(path -> {
                        String childRelative = pathResolver.relativize(root, path);
                        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                            return FileNode.dir(childRelative, path.getFileName().toString(), List.of());
                        }
                        return FileNode.file(childRelative, path.getFileName().toString(), safeSize(path));
                    })
                    .toList();
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "列目录失败: " + ex.getMessage(), ex);
        }
    }

    public FileContent read(Workspace workspace, String relativePath) {
        Path root = rootOf(workspace);
        Path file = pathResolver.resolve(root, relativePath);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "文件不存在: " + relativePath);
        }
        if (Files.isDirectory(file)) {
            throw new ApiException(ErrorCode.NOT_A_FILE, "目标是目录: " + relativePath);
        }

        long size = safeSize(file);
        long limit = properties.maxReadBytes();
        String normalized = pathResolver.relativize(root, file);
        String language = Languages.detect(normalized);

        byte[] bytes;
        try {
            long toRead = Math.min(size, limit);
            try (InputStream in = Files.newInputStream(file)) {
                bytes = in.readNBytes((int) Math.min(toRead, Integer.MAX_VALUE));
            }
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取文件失败: " + ex.getMessage(), ex);
        }

        boolean binary = looksBinary(bytes);
        if (binary) {
            return new FileContent(normalized, null, size, size > limit, true, language);
        }
        return new FileContent(normalized, decodeUtf8(bytes), size, size > limit, false, language);
    }

    /** 只取字节好让上下文组装层复用，不经 JSON 序列化。 */
    public byte[] readBytes(Workspace workspace, String relativePath, long limit) {
        Path file = pathResolver.resolve(rootOf(workspace), relativePath);
        try (InputStream in = Files.newInputStream(file)) {
            return in.readNBytes((int) Math.min(limit, Integer.MAX_VALUE));
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取文件失败: " + ex.getMessage(), ex);
        }
    }

    /**
     * 完整读取文本，<b>超限直接报错而不是截断</b>。
     *
     * <p>应用补丁必须用这个方法：补丁的行号上下文是针对完整文件算的，
     * 用截断后的内容去应用会写出一个残缺文件 —— 这是能真正损坏用户代码的一类错误。
     *
     * @param maxBytes 允许的最大字节数，超出抛 {@link ErrorCode#FILE_TOO_LARGE}
     */
    public String readFullText(Workspace workspace, String relativePath, long maxBytes) {
        Path root = rootOf(workspace);
        Path file = pathResolver.resolve(root, relativePath);
        long size = safeSize(file);
        if (size > maxBytes) {
            throw new ApiException(ErrorCode.FILE_TOO_LARGE,
                    "文件 " + relativePath + " 为 " + (size / 1024) + " KB，超过补丁可处理的 "
                            + (maxBytes / 1024) + " KB 上限");
        }
        try {
            byte[] bytes = Files.readAllBytes(file);
            if (looksBinary(bytes)) {
                throw new ApiException(ErrorCode.DIFF_INVALID, "目标文件是二进制文件，不能应用文本补丁");
            }
            return decodeUtf8(bytes);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取文件失败: " + ex.getMessage(), ex);
        }
    }

    // ------------------------------------------------------------------ 写

    public void writeText(Workspace workspace, String relativePath, String content) {
        writeBytes(workspace, relativePath, content == null ? new byte[0] : content.getBytes(StandardCharsets.UTF_8));
    }

    public void writeBytes(Workspace workspace, String relativePath, byte[] content) {
        Path root = rootOf(workspace);
        Path target = pathResolver.resolve(root, relativePath);
        if (Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.CONFLICT, "同名目录已存在: " + relativePath);
        }
        assertWithinQuota(workspace, content.length);

        try {
            Path parent = target.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Path tmp = Files.createTempFile(parent, ".wcaw-", ".tmp");
            Files.write(tmp, content, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "写入文件失败: " + ex.getMessage(), ex);
        }
    }

    public void createFile(Workspace workspace, String relativePath) {
        Path target = pathResolver.resolve(rootOf(workspace), relativePath);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.CONFLICT, "已存在同名文件或目录: " + relativePath);
        }
        writeBytes(workspace, relativePath, new byte[0]);
    }

    public void createDirectory(Workspace workspace, String relativePath) {
        Path target = pathResolver.resolve(rootOf(workspace), relativePath);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.CONFLICT, "已存在同名文件或目录: " + relativePath);
        }
        try {
            Files.createDirectories(target);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "创建目录失败: " + ex.getMessage(), ex);
        }
    }

    /** 删除文件或目录（递归）。工作区根本身不允许删除。 */
    public void delete(Workspace workspace, String relativePath) {
        Path root = rootOf(workspace);
        Path target = pathResolver.resolve(root, relativePath);
        if (target.equals(root)) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "不能删除工作区根目录");
        }
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "目标不存在: " + relativePath);
        }
        try {
            if (Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
                // 先深后浅地删，逐个删除而不是一把 rmtree，保证删除范围始终可见、可审计
                try (Stream<Path> walk = Files.walk(target)) {
                    List<Path> paths = walk.sorted(Comparator.reverseOrder()).toList();
                    for (Path path : paths) {
                        Files.deleteIfExists(path);
                    }
                }
            } else {
                Files.deleteIfExists(target);
            }
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "删除失败: " + ex.getMessage(), ex);
        }
    }

    // -------------------------------------------------------------- 配额

    public long computeSize(Path root) {
        if (!Files.isDirectory(root)) {
            return 0;
        }
        long[] total = {0};
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile)
                    .filter(path -> !path.toString().contains(java.io.File.separator + ".git" + java.io.File.separator))
                    .forEach(path -> total[0] += safeSize(path));
        } catch (IOException ex) {
            log.warn("统计工作区体积失败: {}", root, ex);
        }
        return total[0];
    }

    /** 写入前预检：当前体积 + 新增字节必须在上限之内。 */
    public void assertWithinQuota(Workspace workspace, long additionalBytes) {
        long current = computeSize(rootOf(workspace));
        long limit = properties.maxWorkspaceBytes();
        if (current + additionalBytes > limit) {
            throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE,
                    "工作区体积将超出上限 " + (limit / 1024 / 1024) + " MB（当前 "
                            + (current / 1024 / 1024) + " MB）");
        }
    }

    // ------------------------------------------------------------ 工具方法

    private static long safeSize(Path path) {
        try {
            return Files.size(path);
        } catch (IOException ex) {
            return 0L;
        }
    }

    /** NUL 字节是判定二进制最可靠的启发式；前 8KB 足够。 */
    private static boolean looksBinary(byte[] bytes) {
        int limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
        for (int i = 0; i < limit; i++) {
            if (bytes[i] == 0) {
                return true;
            }
        }
        return false;
    }

    private static String decodeUtf8(byte[] bytes) {
        var decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPLACE)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPLACE);
        try {
            return decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        } catch (java.nio.charset.CharacterCodingException ex) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}
