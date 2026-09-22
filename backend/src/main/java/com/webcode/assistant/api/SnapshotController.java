package com.webcode.assistant.api;

import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import com.webcode.assistant.workspace.snapshot.SnapshotService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * 工作区快照接口：列出 / 手动创建 / 回滚 / 删除。
 *
 * <p>自动快照由补丁应用触发，不走这里。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/snapshots")
public class SnapshotController {

    private final SnapshotService snapshotService;
    private final WorkspaceService workspaceService;
    private final CurrentUser currentUser;

    public SnapshotController(SnapshotService snapshotService,
                              WorkspaceService workspaceService,
                              CurrentUser currentUser) {
        this.snapshotService = snapshotService;
        this.workspaceService = workspaceService;
        this.currentUser = currentUser;
    }

    @GetMapping
    public List<SnapshotService.SnapshotView> list(@PathVariable long workspaceId) {
        return snapshotService.list(currentUser.requireId(), workspaceId);
    }

    /** 手动快照，可附一句说明。 */
    public record CreateSnapshotRequest(String label) {
    }

    @PostMapping
    public SnapshotService.SnapshotView create(@PathVariable long workspaceId,
                                               @Valid @RequestBody CreateSnapshotRequest request) {
        long userId = currentUser.requireId();
        Workspace workspace = workspaceService.require(userId, workspaceId);
        String label = request.label() == null || request.label().isBlank()
                ? "手动快照"
                : request.label().trim();
        return snapshotService.create(workspace, userId, "manual", label, null);
    }

    @PostMapping("/{snapshotId}/restore")
    public SnapshotService.SnapshotView restore(@PathVariable long workspaceId,
                                                @PathVariable UUID snapshotId) {
        return snapshotService.restore(currentUser.requireId(), workspaceId, snapshotId);
    }

    @DeleteMapping("/{snapshotId}")
    public void delete(@PathVariable long workspaceId, @PathVariable UUID snapshotId) {
        snapshotService.delete(currentUser.requireId(), workspaceId, snapshotId);
    }
}
