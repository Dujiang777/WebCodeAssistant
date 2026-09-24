package com.webcode.assistant.api;

import com.webcode.assistant.agent.ChatSessionService;
import com.webcode.assistant.agent.ToolGateService;
import com.webcode.assistant.security.CurrentUser;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 工具级闸门（功能 14）的审批入口。
 *
 * <p>这是「人机接口从审 diff 提前到审意图」的那只手：Agent 在服务端阻塞等待，
 * 这里收到 approve 之后它才继续执行，而且用的是<b>你改过的参数</b>。
 *
 * <p>四个接口的分工：
 * <ul>
 *   <li>{@code GET /gates} —— 刷新 / 重连后恢复等待中的闸门卡片；</li>
 *   <li>{@code POST /gates/{id}/approve} —— 放行（可带改过的参数）；</li>
 *   <li>{@code POST /gates/{id}/reject} —— 拦下，模型会收到「被拦下了，改用只读手段」；</li>
 *   <li>{@code GET|PUT /gate-policy} —— 改本会话的策略：off 全放行 / writes 拦写操作（默认）/ strict 再拦大范围检索。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/chat/sessions/{sid}")
public class GateController {

    private final ToolGateService gateService;
    private final ChatSessionService sessionService;
    private final CurrentUser currentUser;

    public GateController(ToolGateService gateService,
                          ChatSessionService sessionService,
                          CurrentUser currentUser) {
        this.gateService = gateService;
        this.sessionService = sessionService;
        this.currentUser = currentUser;
    }

    @GetMapping("/gates")
    public List<ToolGateService.PendingView> pending(@PathVariable long sid) {
        sessionService.require(currentUser.requireId(), sid);
        return gateService.pendingOf(sid);
    }

    @PostMapping("/gates/{gateId}/approve")
    public ToolGateService.PendingView approve(@PathVariable long sid,
                                               @PathVariable String gateId,
                                               @RequestBody(required = false) ApiModels.GateApproveRequest request) {
        sessionService.require(currentUser.requireId(), sid);
        Map<String, Object> args = request == null ? null : request.args();
        String note = request == null ? null : request.note();
        return gateService.resolve(sid, gateId, true, args, note);
    }

    @PostMapping("/gates/{gateId}/reject")
    public ToolGateService.PendingView reject(@PathVariable long sid,
                                              @PathVariable String gateId,
                                              @RequestBody(required = false) ApiModels.GateRejectRequest request) {
        sessionService.require(currentUser.requireId(), sid);
        String note = request == null ? null : request.note();
        return gateService.resolve(sid, gateId, false, null, note);
    }

    @GetMapping("/gate-policy")
    public Map<String, String> policy(@PathVariable long sid) {
        sessionService.require(currentUser.requireId(), sid);
        return Map.of("policy", gateService.policyOf(sid));
    }

    @PutMapping("/gate-policy")
    public Map<String, String> updatePolicy(@PathVariable long sid,
                                            @RequestBody ApiModels.GatePolicyRequest request) {
        sessionService.require(currentUser.requireId(), sid);
        String policy = gateService.setPolicy(sid, request == null ? null : request.policy());
        return Map.of("policy", policy);
    }
}
