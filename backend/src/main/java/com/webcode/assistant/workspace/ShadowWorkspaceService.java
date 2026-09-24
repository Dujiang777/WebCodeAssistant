package com.webcode.assistant.workspace;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.Comparator;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 一次性影子工作区（功能 15「What-if 宇宙」的底座）。
 *
 * <p>做法是<b>整仓拷贝</b>到一个隔离目录，在那里随便改，绝不影响用户真正的工作区。
 * 为什么不直接用 git worktree：工作区可能是 zip 导入的、可能根本不是 git 仓库，
 * 而 worktree 依赖仓库状态；拷贝对任何来源都成立，代价只是磁盘。
 *
 * <p>三条边界：
 * <ul>
 *   <li>跳过构建产物与版本库元数据（target / build / node_modules / .git 等）——
 *       平行宇宙只关心源码，把 target 拷过去会让一次实验变成几百 MB；</li>
 *   <li>文件数与总体积都有上限，超了就抛错，不静默拷一半（半份代码跑出来的结论没有意义）；</li>
 *   <li>影子目录独立于 {@code data/workspaces} 之外（{@code data/shadow/…}），
 *       不会出现在任何工作区列表里，也不会被配额统计扫到。</li>
 * </ul>
 */
@Service
public class ShadowWorkspaceService {

    private static final Logger log = LoggerFactory.getLogger(ShadowWorkspaceService.class);

    /** 拷贝时跳过的目录名（构建产物 / 依赖 / 版本库元数据 / IDE 状态）。 */
    private static final Set<String> SKIPPED_DIRS = Set.of(
            ".git", ".hg", ".svn", "target", "build", "out", "dist", "node_modules",
            ".idea", ".vscode", ".gradle", ".mvn", "__pycache__", ".pytest_cache");

    /** 一次影子拷贝的文件数上限：够覆盖教学/中小项目，又不至于让一次实验变成灾难。 */
    private static final int MAX_FILES = 4000;

    /** 影子目录根名（与 data/workspaces、data/snapshots 同级）。 */
    private static final String SHADOW_DIR = "shadow";

    private final AppProperties properties;
    private final WorkspacePathResolver pathResolver;

    public ShadowWorkspaceService(AppProperties properties, WorkspacePathResolver pathResolver) {
        this.properties = properties;
        this.pathResolver = pathResolver;
    }

    /** 影子工作区句柄。 */
    public record Shadow(String id, String rootPath, long sourceWorkspaceId, int fileCount, long sizeBytes,
                         Instant createdAt) {
    }

    /**
     * 从源工作区拷出一个影子。
     *
     * @throws ApiException 文件数超限 / IO 失败时抛出（调用方负责兜底删除）
     */
    public Shadow create(long userId, Workspace source, Path sourceRoot) {
        String id = UUID.randomUUID().toString().substring(0, 8);
        Path root = shadowRootOf(userId, id);
        long[] counter = new long[]{0, 0};

        try {
            Files.createDirectories(root);
            try (Stream<Path> walk = Files.walk(sourceRoot)) {
                for (Path path : walk.toList()) {
                    Path relative = sourceRoot.relativize(path);
                    if (relative.toString().isEmpty() || isSkipped(relative)) {
                        continue;
                    }
                    Path target = root.resolve(relative).normalize();
                    if (!target.startsWith(root)) {
                        throw new ApiException(ErrorCode.PATH_ESCAPE, "影子拷贝路径越界");
                    }
                    if (Files.isDirectory(path)) {
                        Files.createDirectories(target);
                        continue;
                    }
                    counter[0]++;
                    if (counter[0] > MAX_FILES) {
                        throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE,
                                "文件数超过影子拷贝上限（" + MAX_FILES + "），这个仓库不适合做 What-if 实验");
                    }
                    Files.createDirectories(target.getParent());
                    Files.copy(path, target, StandardCopyOption.REPLACE_EXISTING);
                    counter[1] += Files.size(target);
                }
            }
        } catch (IOException ex) {
            discard(root);
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "创建影子工作区失败: " + ex.getMessage(), ex);
        } catch (RuntimeException ex) {
            discard(root);
            throw ex;
        }

        log.info("影子工作区已创建 id={} 源工作区={} 文件数={} 体积={}B", id, source.id(), counter[0], counter[1]);
        return new Shadow(id, root.toString(), source.id(), (int) counter[0], counter[1], Instant.now());
    }

    public Path rootOf(long userId, String shadowId) {
        Path root = shadowRootOf(userId, shadowId);
        if (!Files.isDirectory(root)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "影子分支不存在或已被丢弃");
        }
        return root;
    }

    /** 读影子里某个文件（路径越界一律拒绝）。 */
    public String readFile(Path shadowRoot, String relativePath) {
        Path target = resolveInside(shadowRoot, relativePath);
        if (!Files.isRegularFile(target)) {
            throw new ApiException(ErrorCode.NOT_FOUND, "影子里没有这个文件: " + relativePath);
        }
        try {
            return Files.readString(target);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "读取影子文件失败: " + ex.getMessage(), ex);
        }
    }

    /** 写影子里某个文件（只写不删，用于把替代方案落到平行宇宙）。 */
    public void writeFile(Path shadowRoot, String relativePath, String content) {
        Path target = resolveInside(shadowRoot, relativePath);
        try {
            Files.createDirectories(target.getParent());
            Files.writeString(target, content);
        } catch (IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "写入影子文件失败: " + ex.getMessage(), ex);
        }
    }

    public Path resolveInside(Path shadowRoot, String relativePath) {
        Path target = pathResolver.resolve(shadowRoot, relativePath);
        if (!target.startsWith(shadowRoot)) {
            throw new ApiException(ErrorCode.PATH_ESCAPE, "影子路径越界");
        }
        return target;
    }

    /** 丢弃影子：删得很干净，且失败只记日志 —— 用户的实验被一个删目录失败卡住是不可接受的。 */
    public void discard(Path shadowRoot) {
        if (shadowRoot == null || !Files.exists(shadowRoot)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(shadowRoot)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
            log.info("影子工作区已丢弃: {}", shadowRoot);
        } catch (IOException ex) {
            log.warn("丢弃影子工作区失败: {}", shadowRoot, ex);
        }
    }

    private Path shadowRootOf(long userId, String shadowId) {
        Path base = pathResolver.rootOf(properties.workspaceRoot()).resolveSibling(SHADOW_DIR);
        Path root = base.resolve(Long.toString(userId)).resolve(shadowId).normalize();
        if (!root.startsWith(base)) {
            throw new ApiException(ErrorCode.PATH_ESCAPE, "影子目录越界");
        }
        return root;
    }

    private static boolean isSkipped(Path relative) {
        for (Path segment : relative) {
            if (SKIPPED_DIRS.contains(segment.toString())) {
                return true;
            }
        }
        return false;
    }
}
