package com.webcode.assistant.api;

import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.semantic.SemanticHit;
import com.webcode.assistant.semantic.SemanticIndexService;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 语义检索接口（功能 11）：状态 / 重建索引 / 检索。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/semantic")
public class SemanticController {

    private final SemanticIndexService semanticService;
    private final WorkspaceService workspaceService;
    private final CurrentUser currentUser;

    public SemanticController(SemanticIndexService semanticService,
                              WorkspaceService workspaceService,
                              CurrentUser currentUser) {
        this.semanticService = semanticService;
        this.workspaceService = workspaceService;
        this.currentUser = currentUser;
    }

    /** 索引状态：是否可用、已索引块数。 */
    @GetMapping("/status")
    public Map<String, Object> status(@PathVariable long workspaceId) {
        workspaceService.require(currentUser.requireId(), workspaceId);
        return Map.of(
                "available", semanticService.available(),
                "chunks", semanticService.chunkCount(workspaceId));
    }

    /** 全量重建语义索引（工作区规模下是秒级同步操作）。 */
    @PostMapping("/index")
    public Map<String, Object> reindex(@PathVariable long workspaceId) {
        long userId = currentUser.requireId();
        Workspace workspace = workspaceService.require(userId, workspaceId);
        int chunks = semanticService.reindex(workspace);
        return Map.of("chunks", chunks);
    }

    /** 语义检索请求体。 */
    public record SearchRequest(String query, Integer topK) {
    }

    @PostMapping("/search")
    public SemanticHit.Result search(@PathVariable long workspaceId,
                                     @Valid @RequestBody SearchRequest request) {
        long userId = currentUser.requireId();
        Workspace workspace = workspaceService.require(userId, workspaceId);
        String query = request.query() == null ? "" : request.query().trim();
        if (query.isEmpty()) {
            return new SemanticHit.Result(SemanticHit.OK, "空查询。", semanticService.chunkCount(workspaceId), List.of());
        }
        return semanticService.search(workspace, query, request.topK());
    }
}
