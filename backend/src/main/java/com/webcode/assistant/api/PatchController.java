package com.webcode.assistant.api;

import com.webcode.assistant.agent.BlastRadius;
import com.webcode.assistant.agent.BlastRadiusService;
import com.webcode.assistant.agent.Patch;
import com.webcode.assistant.agent.PatchService;
import com.webcode.assistant.build.BuildResult;
import com.webcode.assistant.build.BuildService;
import com.webcode.assistant.build.CompileIssue;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.Workspace;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * 补丁确认入口，以及应用前后的两个「专业工具」能力。
 *
 * <p>三个接口构成一条完整的判断链：
 * <ol>
 *   <li>{@code GET /{id}/blast-radius} —— <b>应用前</b>：这个补丁改了哪些类、谁在调用、
 *       有没有碰到鉴权/支付/迁移脚本、有没有测试覆盖。用户据此决定敢不敢点；</li>
 *   <li>{@code POST /{id}/apply} —— 人在环上的最后一道闸门，写盘；</li>
 *   <li>{@code POST /{id}/compile} —— <b>应用后</b>：在工作区里真跑一次编译。
 *       失败时返回结构化诊断，前端把它喂回 Agent 出第二轮补丁。</li>
 * </ol>
 *
 * <p>模型永远拿不到写盘能力，也拿不到「构造编译器命令」的能力 ——
 * 后者同样重要：否则它可以借编译参数做别的事。
 */
@RestController
@RequestMapping("/api/patches")
public class PatchController {

    private final PatchService patchService;
    private final BlastRadiusService blastRadiusService;
    private final BuildService buildService;
    private final CurrentUser currentUser;

    public PatchController(PatchService patchService,
                           BlastRadiusService blastRadiusService,
                           BuildService buildService,
                           CurrentUser currentUser) {
        this.patchService = patchService;
        this.blastRadiusService = blastRadiusService;
        this.buildService = buildService;
        this.currentUser = currentUser;
    }

    /** 应用补丁：校验 + 写盘 + 更新工作区体积统计。 */
    @PostMapping("/{patchId}/apply")
    public ApiModels.PatchView apply(@PathVariable UUID patchId) {
        return toView(patchService.apply(currentUser.requireId(), patchId));
    }

    /** 拒绝补丁：只改状态，磁盘不动。 */
    @PostMapping("/{patchId}/reject")
    public ApiModels.PatchView reject(@PathVariable UUID patchId) {
        return toView(patchService.reject(currentUser.requireId(), patchId));
    }

    /**
     * 影响面分析（补丁风险条）。纯只读，不依赖补丁状态 ——
     * 待确认时看是「决策依据」，应用后看是「复盘依据」，都有用。
     */
    @GetMapping("/{patchId}/blast-radius")
    public ApiModels.BlastRadiusView blastRadius(@PathVariable UUID patchId) {
        long userId = currentUser.requireId();
        Patch patch = patchService.require(userId, patchId);
        Workspace workspace = patchService.workspaceOf(userId, patchId);
        BlastRadius radius = blastRadiusService.compute(workspace, patch.filePath(), patch.diffText());
        return toView(radius);
    }

    /**
     * 编译验证。默认只在补丁已应用后允许 —— 没写盘就编译，编译的是旧代码，那个结论没有意义。
     */
    @PostMapping("/{patchId}/compile")
    public ApiModels.BuildResultView compile(@PathVariable UUID patchId) {
        long userId = currentUser.requireId();
        Patch patch = patchService.require(userId, patchId);
        if (!Patch.STATUS_APPLIED.equals(patch.status())) {
            return new ApiModels.BuildResultView(BuildResult.DISABLED, "未知", "", null, 0L, "",
                    List.of(), "补丁尚未应用，编译验证没有意义。请先点「应用并写盘」。");
        }
        Workspace workspace = patchService.workspaceOf(userId, patchId);
        return toView(buildService.compile(workspace));
    }

    // ------------------------------------------------------------ 映射

    private ApiModels.PatchView toView(Patch patch) {
        PatchService.PatchView view = PatchService.PatchView.of(patch);
        return new ApiModels.PatchView(view.id().toString(), view.sessionId(), view.messageId(),
                view.file(), view.diff(), view.status(), view.createdAt(), view.appliedAt());
    }

    private ApiModels.BlastRadiusView toView(BlastRadius radius) {
        List<ApiModels.RefView> callers = radius.callers().stream()
                .map(ref -> new ApiModels.RefView(ref.file(), ref.line(), ref.text(), ref.kind()))
                .toList();
        List<ApiModels.RefView> tests = radius.tests().stream()
                .map(ref -> new ApiModels.RefView(ref.file(), ref.line(), ref.text(), ref.kind()))
                .toList();
        List<ApiModels.RiskView> risks = radius.risks().stream()
                .map(risk -> new ApiModels.RiskView(risk.label(), risk.level(), risk.reason()))
                .toList();
        return new ApiModels.BlastRadiusView(radius.file(), radius.declaredType(), radius.changedMembers(),
                radius.addedLines(), radius.removedLines(), callers, tests, risks,
                radius.riskLevel(), radius.headline(), radius.callersTruncated());
    }

    private ApiModels.BuildResultView toView(BuildResult result) {
        List<ApiModels.CompileIssueView> issues = result.issues().stream()
                .map(this::toView)
                .toList();
        return new ApiModels.BuildResultView(result.status(), result.buildSystem(), result.command(),
                result.exitCode(), result.durationMs(), result.output(), issues, result.note());
    }

    private ApiModels.CompileIssueView toView(CompileIssue issue) {
        return new ApiModels.CompileIssueView(issue.file(), issue.line(), issue.column(),
                issue.message(), issue.severity());
    }
}
