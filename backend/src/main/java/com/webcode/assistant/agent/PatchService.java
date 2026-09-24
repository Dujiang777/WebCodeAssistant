package com.webcode.assistant.agent;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import com.webcode.assistant.workspace.WorkspaceService;
import com.webcode.assistant.workspace.snapshot.Snapshot;
import com.webcode.assistant.workspace.snapshot.SnapshotService;
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
import java.util.ArrayList;
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
    private final SnapshotService snapshotService;
    private final FeatureFlagService featureFlagService;

    public PatchService(PatchRepository patchRepository,
                        ChatSessionRepository sessionRepository,
                        WorkspaceFileService fileService,
                        WorkspacePathResolver pathResolver,
                        WorkspaceService workspaceService,
                        SnapshotService snapshotService,
                        FeatureFlagService featureFlagService) {
        this.patchRepository = patchRepository;
        this.sessionRepository = sessionRepository;
        this.fileService = fileService;
        this.pathResolver = pathResolver;
        this.workspaceService = workspaceService;
        this.snapshotService = snapshotService;
        this.featureFlagService = featureFlagService;
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
     * 用户确认后写盘（单补丁入口）。
     *
     * <p>先用 CAS 认领状态再写文件：并发两个应用请求只会有一次真正落盘；
     * 写失败则把状态退回 pending，保证界面与磁盘状态一致。
     *
     * <p>工作区在这里按「补丁 → 会话 → 工作区」重新解析并做归属校验，而不是由调用方传入 ——
     * 少一个可能传错的参数，就少一类越权风险。
     */
    public Patch apply(long userId, UUID patchId) {
        return apply(userId, patchId, false);
    }

    /**
     * 用户确认后写盘（单补丁入口）。
     *
     * @param flagAcknowledged 是否已确认「关掉特性开关后跑的是旧路径」（功能 16）。
     *                         改动了运行行为的补丁，没确认这一步就不允许落盘 ——
     *                         企业里最贵的事故不是改错，而是改完关不掉。
     */
    public Patch apply(long userId, UUID patchId, boolean flagAcknowledged) {
        Patch patch = requireOwned(userId, patchId);
        if (!Patch.STATUS_PENDING.equals(patch.status())) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED,
                    "该补丁状态为 " + patch.status() + "，不能再次应用");
        }
        assertFlagAcknowledged(userId, patchId, flagAcknowledged);
        Workspace workspace = workspaceOf(userId, patchId);

        // 应用前自动打快照 —— 打点失败就终止应用：没有安全网的写入不值得发生。
        // 快照失败时补丁保持 pending，用户重试即可。
        // 注意：状态检查在上面已经做掉，保证「重复应用被拒」这类调用不会产生多余快照。
        snapshotService.create(workspace, userId, Snapshot.KIND_AUTO,
                "补丁应用前 · " + patch.filePath(), patchId);

        Patch applied = applyCore(userId, patch, workspace);
        workspaceService.refreshSize(workspace);
        return applied;
    }

    /** 批量应用结果：逐补丁的成功 / 失败明细。 */
    public record BatchApplyResult(int total, int applied, int failed, List<Item> items) {

        public record Item(UUID patchId, String file, String status, String error) {
        }
    }

    /**
     * 批量应用一个会话里的全部待确认补丁（功能 10：多文件自动改的落地点）。
     *
     * <p>设计取舍：
     * <ul>
     *   <li><b>整批只打一次快照</b>（而不是每个补丁各打一次）—— 这批变更是同一个决策，
     *       回滚也应该是一个动作；</li>
     *   <li><b>单个失败不阻断整批</b>：补丁之间存在顺序依赖（如先改接口再改实现）时，
     *       前面的失败意味着后面的多半也会失败，但逐个尝试能把「能落盘的都落盘」，
     *       逐补丁的结果明细让用户清楚看到哪几个需要人工处理；</li>
     *   <li>应用顺序按补丁生成顺序（id 升序），与模型产出顺序一致。</li>
     * </ul>
     */
    public BatchApplyResult applyAll(long userId, long sessionId) {
        return applyAll(userId, sessionId, false);
    }

    public BatchApplyResult applyAll(long userId, long sessionId, boolean flagAcknowledged) {
        requireSession(userId, sessionId);
        List<Patch> pending = patchRepository.findBySession(sessionId).stream()
                .filter(patch -> Patch.STATUS_PENDING.equals(patch.status()))
                .toList();
        if (pending.isEmpty()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "没有待确认的补丁");
        }

        Workspace workspace = workspaceService.require(userId,
                sessionRepository.findOwned(sessionId, userId).orElseThrow().workspaceId());

        snapshotService.create(workspace, userId, Snapshot.KIND_AUTO,
                "批量应用前 · " + pending.size() + " 个补丁", null);

        List<BatchApplyResult.Item> items = new ArrayList<>(pending.size());
        int applied = 0;
        int failed = 0;
        for (Patch patch : pending) {
            try {
                assertFlagAcknowledged(userId, patch.id(), flagAcknowledged);
                applyCore(userId, patch, workspace);
                applied++;
                items.add(new BatchApplyResult.Item(patch.id(), patch.filePath(), Patch.STATUS_APPLIED, null));
            } catch (RuntimeException ex) {
                failed++;
                String message = ex instanceof ApiException apiException
                        ? apiException.getMessage()
                        : "应用失败";
                items.add(new BatchApplyResult.Item(patch.id(), patch.filePath(), Patch.STATUS_PENDING, message));
            }
        }
        if (applied > 0) {
            workspaceService.refreshSize(workspace);
        }
        log.info("批量应用完成 session={} 总数={} 成功={} 失败={}", sessionId, pending.size(), applied, failed);
        return new BatchApplyResult(pending.size(), applied, failed, items);
    }

    /** CAS 认领 + 写盘。调用方负责快照与体积刷新。 */
    private Patch applyCore(long userId, Patch patch, Workspace workspace) {
        UUID patchId = patch.id();
        if (!Patch.STATUS_PENDING.equals(patch.status())) {
            throw new ApiException(ErrorCode.PATCH_ALREADY_RESOLVED,
                    "该补丁状态为 " + patch.status() + "，不能再次应用");
        }

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

    /**
     * 应用前的开关确认闸门（功能 16）。只有「判定为行为变化」的补丁才拦，
     * 纯注释 / 测试 / 非源码一律直接放行 —— 否则开关会退化成噪音。
     */
    private void assertFlagAcknowledged(long userId, UUID patchId, boolean acknowledged) {
        if (acknowledged) {
            return;
        }
        FeatureFlagService.FlagView flag = featureFlagService.analyze(userId, patchId);
        if (flag.required()) {
            throw new ApiException(ErrorCode.FLAG_ACK_REQUIRED,
                    "这个补丁改动了运行行为（开关 " + flag.flagKey() + "，" + flag.reason()
                            + "）。请先确认「关闭开关时跑旧路径」，并在应用请求里带上 acknowledgeFlag=true。");
        }
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
