package com.webcode.assistant.api;

import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.terminal.TerminalResult;
import com.webcode.assistant.terminal.TerminalService;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 网页终端接口（功能 12）。
 *
 * <p>这个端点<b>只服务于人</b>：JWT 鉴权 + 工作区归属校验 + cwd 锁定 + 元字符拒绝。
 * 模型的工具清单（AgentToolbox）里没有任何命令执行能力 —— 两套入口物理隔离。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/terminal")
public class TerminalController {

    private final TerminalService terminalService;
    private final WorkspaceService workspaceService;
    private final CurrentUser currentUser;

    public TerminalController(TerminalService terminalService,
                              WorkspaceService workspaceService,
                              CurrentUser currentUser) {
        this.terminalService = terminalService;
        this.workspaceService = workspaceService;
        this.currentUser = currentUser;
    }

    /** 执行命令请求体。 */
    public record RunRequest(String command) {
    }

    @PostMapping("/run")
    public TerminalResult run(@PathVariable long workspaceId, @Valid @RequestBody RunRequest request) {
        long userId = currentUser.requireId();
        Workspace workspace = workspaceService.require(userId, workspaceId);
        return terminalService.run(workspace, request.command());
    }
}
