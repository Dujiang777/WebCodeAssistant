package com.webcode.assistant.api;

import com.webcode.assistant.agent.AgentDeskService;
import com.webcode.assistant.agent.ChatSession;
import com.webcode.assistant.agent.ChatSessionService;
import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.WorkspaceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Agent 工位（功能 13）的读取入口。
 *
 * <p>工位状态平时走 SSE 的 {@code desk} 事件实时更新；这个接口解决两个场景：
 * <ul>
 *   <li>刚打开面板 / 刷新页面 —— 先拉一次现状，不必等下一次工具调用；</li>
 *   <li>SSE 断线的兜底 —— 重连失败时也能看到 Agent 现在停在哪。</li>
 * </ul>
 * 只读，且必须带会话 id：工位是「某个会话里的 Agent」的状态，不是工作区的属性。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/desk")
public class DeskController {

    private final AgentDeskService deskService;
    private final ChatSessionService sessionService;
    private final WorkspaceService workspaceService;
    private final CurrentUser currentUser;

    public DeskController(AgentDeskService deskService,
                          ChatSessionService sessionService,
                          WorkspaceService workspaceService,
                          CurrentUser currentUser) {
        this.deskService = deskService;
        this.sessionService = sessionService;
        this.workspaceService = workspaceService;
        this.currentUser = currentUser;
    }

    @GetMapping
    public AgentDeskService.DeskView desk(@PathVariable long workspaceId, @RequestParam long sessionId) {
        long userId = currentUser.requireId();
        workspaceService.require(userId, workspaceId);
        ChatSession session = sessionService.require(userId, sessionId);
        if (session.workspaceId() != workspaceId) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "会话不属于该工作区");
        }
        return deskService.view(sessionId);
    }
}
