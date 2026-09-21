package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import com.webcode.assistant.workspace.WorkspaceService;
import com.webcode.assistant.workspace.diff.FilePatch;
import com.webcode.assistant.workspace.diff.UnifiedDiffApplier;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 补丁生命周期：生成 → 待确认 → 应用 / 拒绝。
 *
 * <p><b>这是「人在环上」的落地点。</b>模型永远拿不到写盘能力：
 * {@code propose_patch} 只产出 unified diff 并落库，真正的写盘只发生在
 * {@link #apply} 里，且必须由用户在前端点「应用」触发。
 *
 * <p>三道校验：
 * <ol>
 *   <li><b>生成时</b>：解析 diff，确认「只涉及一个文件」「路径在工作区内」「能干净地应用到当前内容」——
 *       所以前端展示出来的补丁是「保证可应用」的，不会出现用户点了应用才发现冲突；</li>
 *   <li><b>应用时</b>：重新读取文件并再次校验，防止「生成」与「应用」之间文件被别人改动（TOCTOU）；</li>
 *   <li><b>状态流转</b>：用带条件的 update 做 CAS，保证同一补丁只会被应用或拒绝一次。</li>
 * </ol>
 */
@Service
public class PatchService {

    private static final Logger log = LoggerFactory.getLogger(PatchService.class);

    /**
     * 可被打补丁的单个文件体积上限。比 {@code app.max-read-bytes}（默认 512KB，供浏览与送模型）
     * 宽松得多 —— 大文件依然能被人完整地改，只是不能被完整地塞进 prompt。
     */
    private static final long MAX_PATCHABLE_BYTES = 8L * 1024 * 1024;

    private final PatchRepository patchRepository;
    private final ChatSessionRepository sessionRepository;
    private final WorkspaceFileService fileService;
    private final WorkspacePathResolver pathResolver;
    private final WorkspaceService workspaceService;

    public PatchService(PatchRepository patchRepository,
                        ChatSessionRepository sessionRepository,
                        WorkspaceFileService fileService,
                        WorkspacePathResolver pathResolver,
                        WorkspaceService workspaceService) {
        this.patchRepository = patchRepository;
        this.sessionRepository = sessionRepository;
        this.fileService = fileService;
        this.pathResolver = pathResolver;
        this.workspaceService = workspaceService;
    }

    /**
     * 由 Agent 工具调用：校验并落库一个待确认补丁。
     *
     * @return 落库后的补丁；调用方负责把它推给 SSE
     * @throws ApiException 校验不通过时抛出，异常消息会作为工具结果回给模型，让它重新生成
     */
    public Patch propose(long sessionId, Long messageId, Workspace workspace,
                         String declaredPath, String diffText) {
        String path = normalizeDeclaredPath(declaredPath);
        List<FilePatch> parsed = UnifiedDiffParser.parse(diffText, path);

        if (parsed.size() != 1) {
            throw new ApiException(ErrorCode.DIFF_INVALID,
                    "一次补丁只能修改一个文件，当前包含 " + parsed.size() + " 个文件。请拆成多次 propose_patch。");
        }
        FilePatch filePatch = parsed.get(0);
        String diffPath = normalizeDeclaredPath(filePatch.targetPath());
        if (!diffPath.equals(path)) {
            throw new ApiException(ErrorCode.DIFF_INVALID,
                    "diff 头部的文件路径（" + diffPath + "）与 file 参数（" + path + "）不一致，请修正后重试。");
        }

        // 路径边界：越界会在这里抛 PATH_ESCAPE
        Path target = resolveTarget(workspace, path);
        String current = readCurrentContent(workspace, path, target);

        // 干跑一次，确保这个补丁确实能应用；不能应用就不该拿去打扰用户
        UnifiedDiffApplier.apply(current, filePatch);

        UUID id = patchRepository.insert(sessionId, messageId, path, diffText);
        log.info("生成补丁 {} 会话 {} 文件 {}（+{} / -{}）",
                id, sessionId, path, filePatch.addedLines(), filePatch.removedLines());
        return patchRepository.findById(id).orElseThrow();
    }

    /**
     * 用户确认后写盘。
     *
     * <p>先用 CAS 认领状态再写文件：并发两个应用请求只会有一次真正落盘；
     * 写失败则把状态退回 pending，保证界面与磁盘状态一致。
     *
     * <p>工作区在这里按「补丁 → 会话 → 工作区」重新解析并做归属校验，而不是由调用方传入 ——
     * 少一个可能传错的参数，就少一类越权风险。
     */
    public Patch apply(long userId, UUID patchId) {
        Patch patch = requireOwned(userId, patchId);
        if (!Patch.STATUS_PENDING.equals(patch.status())) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED,
                    "该补丁状态为 " + patch.status() + "，不能再次应用");
        }
        Workspace workspace = workspaceOf(userId, patchId);

        if (!patchRepository.markResolved(patchId, Patch.STATUS_APPLIED)) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED, "该补丁已被处理");
        }

        try {
            FilePatch filePatch = UnifiedDiffParser.parse(patch.diffText(), patch.filePath()).get(0);
            Path target = resolveTarget(workspace, patch.filePath());
            String current = readCurrentContent(workspace, patch.filePath(), target);
            String updated = UnifiedDiffApplier.apply(current, filePatch);

            if (filePatch.deletesFile()) {
                fileService.delete(workspace, patch.filePath());
            } else {
                // writeText 内部已做过配额校验，这里不再重复统计整个工作区体积
                fileService.writeText(workspace, patch.filePath(), updated);
            }
            workspaceService.refreshSize(workspace);
            log.info("补丁 {} 已应用，文件 {}", patchId, patch.filePath());
        } catch (RuntimeException ex) {
            patchRepository.revertToPending(patchId);
            throw ex;
        }

        return patchRepository.findById(patchId).orElseThrow();
    }

    public Patch reject(long userId, UUID patchId) {
        Patch patch = requireOwned(userId, patchId);
        if (!Patch.STATUS_PENDING.equals(patch.status())) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED,
                    "该补丁状态为 " + patch.status() + "，不能再次拒绝");
        }
        if (!patchRepository.markResolved(patchId, Patch.STATUS_REJECTED)) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED, "该补丁已被处理");
        }
        return patchRepository.findById(patchId).orElseThrow();
    }

    public Patch require(long userId, UUID patchId) {
        return requireOwned(userId, patchId);
    }

    /**
     * 解析补丁所属的工作区（含归属校验）。
     *
     * <p>影响面分析与编译验证都要在补丁所属的工作区里做；把这条链路收在这里，
     * 避免每加一个只读接口就复制一遍「补丁 → 会话 → 工作区」的归属判断。
     */
    public Workspace workspaceOf(long userId, UUID patchId) {
        Patch patch = requireOwned(userId, patchId);
        ChatSession session = sessionRepository.findOwned(patch.sessionId(), userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "会话不存在或无权访问"));
        return workspaceService.require(userId, session.workspaceId());
    }

    public List<Patch> listBySession(long userId, long sessionId) {
        requireSession(userId, sessionId);
        return patchRepository.findBySession(sessionId);
    }

    public void attachMessage(UUID patchId, long messageId) {
        patchRepository.attachMessage(patchId, messageId);
    }

    // ------------------------------------------------------------ 内部工具

    private Patch requireOwned(long userId, UUID patchId) {
        return patchRepository.findOwned(patchId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "补丁不存在或无权访问"));
    }

    private void requireSession(long userId, long sessionId) {
        sessionRepository.findOwned(sessionId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "会话不存在或无权访问"));
    }

    private Path resolveTarget(Workspace workspace, String relativePath) {
        return pathResolver.resolve(fileService.rootOf(workspace), relativePath);
    }

    /** 读取原文件内容用于干跑 / 应用；文件不存在返回 null（新建文件场景）。 */
    private String readCurrentContent(Workspace workspace, String relativePath, Path target) {
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        // 必须整文件读取：用截断后的内容应用补丁会写出一个残缺文件
        return fileService.readFullText(workspace, relativePath, MAX_PATCHABLE_BYTES);
    }

    /** 统一去掉前缀斜杠并规范分隔符，保证与 diff 头部路径可比。 */
    private String normalizeDeclaredPath(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "必须提供文件路径");
        }
        String path = raw.trim().replace('\\', '/');
        while (path.startsWith("./")) {
            path = path.substring(2);
        }
        while (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "文件路径不能为空");
        }
        return path;
    }

    /** 补丁的对外视图。 */
    public record PatchView(UUID id, long sessionId, Long messageId, String file, String diff,
                            String status, String createdAt, String appliedAt) {

        public static PatchView of(Patch patch) {
            return new PatchView(
                    patch.id(),
                    patch.sessionId(),
                    patch.messageId(),
                    patch.filePath(),
                    patch.diffText(),
                    patch.status(),
                    iso(patch.createdAt()),
                    patch.appliedAt() == null ? null : patch.appliedAt().toString());
        }

        private static String iso(Instant instant) {
            return instant == null ? null : instant.toString();
        }
    }
}
