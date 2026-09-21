package com.webcode.assistant.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 会话的增删查。放在这里而不是控制器里，是为了让控制器只负责 HTTP 语义；
 * 同时把「会话必须属于当前用户且属于指定工作区」这条规则收敛在一处。
 */
@Service
public class ChatSessionService {

    private static final Logger log = LoggerFactory.getLogger(ChatSessionService.class);
    private static final int DEFAULT_TITLE_MAX = 60;

    private final ChatSessionRepository sessionRepository;
    private final ChatMessageRepository messageRepository;
    private final WorkspaceService workspaceService;
    private final ChatEventHub eventHub;
    private final ObjectMapper objectMapper;

    public ChatSessionService(ChatSessionRepository sessionRepository,
                              ChatMessageRepository messageRepository,
                              WorkspaceService workspaceService,
                              ChatEventHub eventHub,
                              ObjectMapper objectMapper) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.workspaceService = workspaceService;
        this.eventHub = eventHub;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public ChatSession create(long userId, long workspaceId, String title) {
        Workspace workspace = workspaceService.require(userId, workspaceId);
        String finalTitle = (title == null || title.isBlank())
                ? "与「" + workspace.name() + "」的对话"
                : title.trim();
        if (finalTitle.length() > DEFAULT_TITLE_MAX) {
            finalTitle = finalTitle.substring(0, DEFAULT_TITLE_MAX);
        }
        long id = sessionRepository.insert(workspaceId, userId, finalTitle);
        return require(userId, id);
    }

    @Transactional(readOnly = true)
    public ChatSession require(long userId, long sessionId) {
        return sessionRepository.findOwned(sessionId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "会话不存在或无权访问"));
    }

    @Transactional(readOnly = true)
    public List<ChatSession> list(long userId, Long workspaceId) {
        if (workspaceId == null) {
            // 未指定工作区时，按用户维度聚合：先取该用户所有工作区再查会话
            List<ChatSession> all = new java.util.ArrayList<>();
            for (Workspace workspace : workspaceService.list(userId)) {
                all.addAll(sessionRepository.findAllByWorkspace(workspace.id(), userId));
            }
            all.sort(java.util.Comparator.comparing(ChatSession::updatedAt).reversed());
            return all;
        }
        workspaceService.require(userId, workspaceId);
        return sessionRepository.findAllByWorkspace(workspaceId, userId);
    }

    @Transactional(readOnly = true)
    public List<ChatMessageRecord> messages(long userId, long sessionId) {
        require(userId, sessionId);
        return messageRepository.findBySession(sessionId);
    }

    @Transactional
    public void delete(long userId, long sessionId) {
        require(userId, sessionId);
        sessionRepository.deleteOwned(sessionId, userId);
        // 释放该会话的事件缓冲与订阅，避免长期占用内存
        eventHub.dispose(sessionId);
        log.info("会话 {} 已删除（用户 {}）", sessionId, userId);
    }

    /** 把 meta 的 jsonb 原文字符串解析成 JSON 树；解析失败时降级为 null，不影响消息正文展示。 */
    public JsonNode parseMeta(String metaJson) {
        if (metaJson == null || metaJson.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(metaJson);
        } catch (Exception ex) {
            log.debug("解析消息 meta 失败: {}", ex.getMessage());
            return null;
        }
    }
}
