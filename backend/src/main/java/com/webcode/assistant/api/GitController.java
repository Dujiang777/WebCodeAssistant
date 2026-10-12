package com.webcode.assistant.api;

import com.webcode.assistant.scm.GitWorkspaceService;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 工作区本地 Git。只给人用：状态、初始化、提交。没有 push。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/git")
public class GitController {

    private final GitWorkspaceService gitWorkspaceService;
    private final WorkspaceService workspaceService;
    private final CurrentUser currentUser;

    public GitController(GitWorkspaceService gitWorkspaceService,
                         WorkspaceService workspaceService,
                         CurrentUser currentUser) {
        this.gitWorkspaceService = gitWorkspaceService;
        this.workspaceService = workspaceService;
        this.currentUser = currentUser;
    }

    @GetMapping
    public GitWorkspaceService.GitStatusView status(@PathVariable long workspaceId) {
        return gitWorkspaceService.status(require(workspaceId));
    }

    @PostMapping("/init")
    public GitWorkspaceService.GitStatusView init(@PathVariable long workspaceId) {
        return gitWorkspaceService.init(require(workspaceId));
    }

    @PostMapping("/commit")
    public GitWorkspaceService.GitCommitView commit(@PathVariable long workspaceId,
                                                    @RequestBody(required = false) ApiModels.GitCommitRequest request) {
        String message = request == null ? "" : request.message();
        return gitWorkspaceService.commit(require(workspaceId), message, currentUser.require().username());
    }

    private Workspace require(long workspaceId) {
        return workspaceService.require(currentUser.requireId(), workspaceId);
    }
}
