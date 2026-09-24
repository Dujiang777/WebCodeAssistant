package com.webcode.assistant.api;

import com.webcode.assistant.agent.ChatSessionService;
import com.webcode.assistant.agent.WhatIfService;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.WorkspaceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 反事实分支 / What-if 宇宙（功能 15）的入口。
 *
 * <p>一次实验的生命周期：{@code POST}（开一个新的平行宇宙）→ {@code GET}（看左右对照）→
 * 二选一结束：{@code discard}（默认结局，影子删掉）或 {@code adopt}（变成主线上的待确认补丁）。
 *
 * <p>注意 {@code adopt} <b>不是</b>直接写盘：它只是把平行宇宙的改法搬回主线流程的起点，
 * 后面照旧要过「快照 → 确认 → 应用」。反事实实验不该成为绕过审查的捷径。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/whatif")
public class WhatIfController {

    private final WhatIfService whatIfService;
    private final WorkspaceService workspaceService;
    private final ChatSessionService sessionService;
    private final CurrentUser currentUser;

    public WhatIfController(WhatIfService whatIfService,
                            WorkspaceService workspaceService,
                            ChatSessionService sessionService,
                            CurrentUser currentUser) {
        this.whatIfService = whatIfService;
        this.workspaceService = workspaceService;
        this.sessionService = sessionService;
        this.currentUser = currentUser;
    }

    @GetMapping
    public List<WhatIfService.BranchView> list(@PathVariable long workspaceId) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        return whatIfService.list(userId, workspaceId);
    }

    @PostMapping
    public WhatIfService.BranchView ask(@PathVariable long workspaceId,
                                       @RequestBody ApiModels.WhatIfRequest request) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        sessionService.require(userId, request.sessionId());
        return whatIfService.ask(userId, workspaceId, request.sessionId(), request.question(), request.file());
    }

    @GetMapping("/{branchId}")
    public WhatIfService.BranchView get(@PathVariable long workspaceId, @PathVariable String branchId) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        return whatIfService.get(userId, branchId);
    }

    /** 丢弃：默认结局。影子目录一并删除。 */
    @PostMapping("/{branchId}/discard")
    public WhatIfService.BranchView discard(@PathVariable long workspaceId, @PathVariable String branchId) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        return whatIfService.discard(userId, branchId);
    }

    /** 采纳：平行宇宙的改法转成主线上的待确认补丁（仍需人工审阅后应用）。 */
    @PostMapping("/{branchId}/adopt")
    public WhatIfService.AdoptResult adopt(@PathVariable long workspaceId, @PathVariable String branchId) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        return whatIfService.adopt(userId, branchId);
    }
}
