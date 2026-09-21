package com.webcode.assistant.api;

import com.webcode.assistant.agent.AgentOrchestrator;
import com.webcode.assistant.agent.AgentRequest;
import com.webcode.assistant.agent.ChatEventHub;
import com.webcode.assistant.agent.ChatMessageRecord;
import com.webcode.assistant.agent.ChatSession;
import com.webcode.assistant.agent.ChatSessionService;
import com.webcode.assistant.agent.Patch;
import com.webcode.assistant.agent.PatchService;
import com.webcode.assistant.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

/**
 * 对话接口：会话管理、消息历史、SSE 事件流、补丁列表。
 *
 * <p>两个通道的分工：
 * <ul>
 *   <li>{@code POST /{sid}/messages} —— 普通 JSON，<b>立刻</b>返回 {@code messageId}；</li>
 *   <li>{@code GET /{sid}/events} —— SSE 长连接，承载流式增量、工具事件与补丁。</li>
 * </ul>
 * 前端拿到 {@code messageId} 后不需要等待，事件会从已建立的 SSE 通道推过来。
 * 如果 SSE 当时恰好断着，事件会进会话缓冲，重连时带 {@code afterId} 即可补齐。
 */
@RestController
@RequestMapping("/api/chat/sessions")
public class ChatController {

    private final ChatSessionService sessionService;
    private final AgentOrchestrator orchestrator;
    private final ChatEventHub eventHub;
    private final PatchService patchService;
    private final CurrentUser currentUser;

    public ChatController(ChatSessionService sessionService,
                          AgentOrchestrator orchestrator,
                          ChatEventHub eventHub,
                          PatchService patchService,
                          CurrentUser currentUser) {
        this.sessionService = sessionService;
        this.orchestrator = orchestrator;
        this.eventHub = eventHub;
        this.patchService = patchService;
        this.currentUser = currentUser;
    }

    @PostMapping
    public ResponseEntity<ApiModels.SessionView> create(@Valid @RequestBody ApiModels.CreateSessionRequest request) {
        ChatSession session = sessionService.create(currentUser.requireId(), request.workspaceId(), null);
        return ResponseEntity.status(HttpStatus.CREATED).body(toView(session));
    }

    @GetMapping
    public List<ApiModels.SessionView> list(@RequestParam(value = "workspaceId", required = false) Long workspaceId) {
        return sessionService.list(currentUser.requireId(), workspaceId).stream().map(this::toView).toList();
    }

    @GetMapping("/{sid}/messages")
    public List<ApiModels.MessageView> messages(@PathVariable long sid) {
        return sessionService.messages(currentUser.requireId(), sid).stream()
                .map(this::toView)
                .toList();
    }

    /**
     * 发消息。返回后 Agent 在虚拟线程里跑，事件从 SSE 通道推送。
     */
    @PostMapping("/{sid}/messages")
    public ResponseEntity<ApiModels.SendMessageResponse> send(@PathVariable long sid,
                                                             @Valid @RequestBody ApiModels.SendMessageRequest request) {
        long userId = currentUser.requireId();
        ChatSession session = sessionService.require(userId, sid);

        AgentRequest agentRequest = new AgentRequest(
                sid,
                session.workspaceId(),
                userId,
                request.content(),
                request.currentFile(),
                request.toSelection(),
                AgentRequest.normalizeMode(request.mode()));

        long messageId = orchestrator.start(agentRequest);
        return ResponseEntity.accepted().body(new ApiModels.SendMessageResponse(messageId, sid));
    }

    /**
     * SSE 事件流。
     *
     * @param afterId 可选。前端重连时带上最后收到的 {@code seq}，可回放断线期间漏掉的事件；
     *                不传则只接收之后产生的新事件
     */
    @GetMapping(value = "/{sid}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable long sid,
                             @RequestParam(value = "afterId", required = false) Long afterId) {
        // 归属校验必须在建立长连接之前完成，否则会先提交响应再发现越权
        sessionService.require(currentUser.requireId(), sid);
        return eventHub.subscribe(sid, afterId);
    }

    @GetMapping("/{sid}/patches")
    public List<ApiModels.PatchView> patches(@PathVariable long sid) {
        return patchService.listBySession(currentUser.requireId(), sid).stream()
                .map(this::toView)
                .toList();
    }

    @DeleteMapping("/{sid}")
    public ResponseEntity<Void> delete(@PathVariable long sid) {
        sessionService.delete(currentUser.requireId(), sid);
        return ResponseEntity.noContent().build();
    }

    private ApiModels.SessionView toView(ChatSession session) {
        return new ApiModels.SessionView(session.id(), session.workspaceId(), session.title(),
                session.createdAt().toString(), session.updatedAt().toString());
    }

    private ApiModels.MessageView toView(ChatMessageRecord record) {
        return new ApiModels.MessageView(record.id(), record.role(), record.content(),
                sessionService.parseMeta(record.metaJson()), record.createdAt().toString());
    }

    private ApiModels.PatchView toView(Patch patch) {
        PatchService.PatchView view = PatchService.PatchView.of(patch);
        return new ApiModels.PatchView(view.id().toString(), view.sessionId(), view.messageId(),
                view.file(), view.diff(), view.status(), view.createdAt(), view.appliedAt());
    }
}
