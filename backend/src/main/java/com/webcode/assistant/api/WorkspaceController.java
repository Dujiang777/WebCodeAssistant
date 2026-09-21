package com.webcode.assistant.api;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.workspace.FileContent;
import com.webcode.assistant.workspace.FileNode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import com.webcode.assistant.workspace.WorkspaceService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
 * 工作区与文件的 REST 接口。
 *
 * <p>所有写操作都会走 {@link WorkspaceFileService}，而它内部只通过
 * {@code WorkspacePathResolver} 解析路径 —— 控制器这一层不需要（也不允许）自己拼路径。
 */
@RestController
@RequestMapping("/api/workspaces")
public class WorkspaceController {

    private final WorkspaceService workspaceService;
    private final WorkspaceFileService fileService;
    private final CurrentUser currentUser;

    public WorkspaceController(WorkspaceService workspaceService,
                               WorkspaceFileService fileService,
                               CurrentUser currentUser) {
        this.workspaceService = workspaceService;
        this.fileService = fileService;
        this.currentUser = currentUser;
    }

    // ------------------------------------------------------------- 工作区

    @GetMapping
    public List<ApiModels.WorkspaceView> list() {
        return ApiModels.WorkspaceView.of(workspaceService.list(currentUser.requireId()));
    }

    /** 从 Git 地址或内置样例创建。zip 导入见下面的 multipart 重载。 */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ApiModels.WorkspaceView> create(@Valid @RequestBody ApiModels.CreateWorkspaceRequest request) {
        long userId = currentUser.requireId();
        boolean useSample = Boolean.TRUE.equals(request.sample());
        boolean hasGitUrl = request.gitUrl() != null && !request.gitUrl().isBlank();

        if (useSample && hasGitUrl) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "sample 与 gitUrl 不能同时提供");
        }
        if (!useSample && !hasGitUrl) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "请提供 gitUrl，或指定 sample=true 使用内置演示项目");
        }

        Workspace workspace = useSample
                ? workspaceService.createFromSample(userId, request.name())
                : workspaceService.createFromGit(userId, request.name(), request.gitUrl());

        return ResponseEntity.status(HttpStatus.CREATED).body(ApiModels.WorkspaceView.of(workspace));
    }

    /** 上传 zip 导入。 */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ApiModels.WorkspaceView> createFromArchive(
            @RequestPart("file") MultipartFile file,
            @RequestParam(value = "name", required = false) String name) {
        Workspace workspace = workspaceService.createFromArchive(
                currentUser.requireId(), name, file.getOriginalFilename(), file);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiModels.WorkspaceView.of(workspace));
    }

    @GetMapping("/{id}")
    public ApiModels.WorkspaceView detail(@PathVariable long id) {
        return ApiModels.WorkspaceView.of(workspaceService.require(currentUser.requireId(), id));
    }

    // --------------------------------------------------------------- 文件

    @GetMapping("/{id}/tree")
    public FileNode tree(@PathVariable long id) {
        return fileService.tree(requireWorkspace(id));
    }

    @GetMapping("/{id}/files")
    public ApiModels.FileContentView readFile(@PathVariable long id,
                                              @RequestParam("path") String path) {
        Workspace workspace = requireWorkspace(id);
        FileContent content = fileService.read(workspace, path);
        return new ApiModels.FileContentView(content.path(), content.content(), content.sizeBytes(),
                content.truncated(), content.binary(), content.language());
    }

    @PutMapping("/{id}/files")
    public ApiModels.FileContentView saveFile(@PathVariable long id,
                                             @RequestParam("path") String path,
                                             @RequestBody ApiModels.SaveFileRequest request) {
        Workspace workspace = requireWorkspace(id);
        fileService.writeText(workspace, path, request.content());
        workspaceService.refreshSize(workspace);
        FileContent content = fileService.read(workspace, path);
        return new ApiModels.FileContentView(content.path(), content.content(), content.sizeBytes(),
                content.truncated(), content.binary(), content.language());
    }

    /** 新建文件或目录。 */
    @PostMapping("/{id}/entries")
    public ResponseEntity<ApiModels.WorkspaceView> createEntry(@PathVariable long id,
                                                              @Valid @RequestBody ApiModels.CreateEntryRequest request) {
        Workspace workspace = requireWorkspace(id);
        switch (request.type()) {
            case "file" -> fileService.createFile(workspace, request.path());
            case "dir" -> fileService.createDirectory(workspace, request.path());
            default -> throw new ApiException(ErrorCode.BAD_REQUEST, "type 只能是 file 或 dir");
        }
        workspaceService.refreshSize(workspace);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiModels.WorkspaceView.of(workspace));
    }

    @DeleteMapping("/{id}/files")
    public ResponseEntity<Void> deleteFile(@PathVariable long id, @RequestParam("path") String path) {
        Workspace workspace = requireWorkspace(id);
        fileService.delete(workspace, path);
        workspaceService.refreshSize(workspace);
        return ResponseEntity.noContent().build();
    }

    private Workspace requireWorkspace(long id) {
        return workspaceService.require(currentUser.requireId(), id);
    }
}
