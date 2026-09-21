package com.webcode.assistant.api;

import com.webcode.assistant.agent.AgentRequest;
import com.webcode.assistant.workspace.Workspace;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * HTTP 层的请求 / 响应模型。
 *
 * <p>刻意把「数据库实体」和「对外模型」分开：
 * <ul>
 *   <li>{@link WorkspaceView} 不含 {@code root_path}，服务端磁盘结构不下发；</li>
 *   <li>认证响应不含任何模型配置，Key 永远不会经过前端。</li>
 * </ul>
 */
public final class ApiModels {

    private ApiModels() {
    }

    // ------------------------------------------------------------- 认证

    public record RegisterRequest(
            @NotBlank(message = "不能为空") @Size(min = 3, max = 64, message = "长度需在 3-64 之间") String username,
            @NotBlank(message = "不能为空") @Size(min = 6, max = 128, message = "长度需在 6-128 之间") String password
    ) {
    }

    public record LoginRequest(
            @NotBlank(message = "不能为空") String username,
            @NotBlank(message = "不能为空") String password
    ) {
    }

    public record AuthResponse(long userId, String username, String token, long expiresInSeconds) {
    }

    public record MeResponse(long userId, String username) {
    }

    // --------------------------------------------------------- 工作区

    /**
     * 创建工作区。三种方式互斥：
     * <ul>
     *   <li>只给 {@code gitUrl} → 从 Git 克隆；</li>
     *   <li>{@code sample=true} → 使用内置演示项目；</li>
     *   <li>上传 zip（multipart 请求）→ 解压导入。</li>
     * </ul>
     */
    public record CreateWorkspaceRequest(
            @Size(max = 120, message = "长度不能超过 120") String name,
            @Size(max = 2048, message = "长度不能超过 2048") String gitUrl,
            Boolean sample
    ) {
    }

    public record WorkspaceView(long id, String name, String gitUrl, long sizeBytes, String createdAt) {

        public static WorkspaceView of(Workspace workspace) {
            return new WorkspaceView(
                    workspace.id(),
                    workspace.name(),
                    workspace.gitUrl(),
                    workspace.sizeBytes(),
                    workspace.createdAt().toString());
        }

        public static List<WorkspaceView> of(List<Workspace> workspaces) {
            return workspaces.stream().map(WorkspaceView::of).toList();
        }
    }

    // --------------------------------------------------------- 文件

    public record FileContentView(String path, String content, long sizeBytes, boolean truncated,
                                  boolean binary, String language) {
    }

    public record SaveFileRequest(String content) {
    }

    public record CreateEntryRequest(
            @NotBlank(message = "不能为空") @Size(max = 1024, message = "路径过长") String path,
            /** {@code file} 或 {@code dir} */
            @NotBlank(message = "不能为空") String type
    ) {
    }

    // --------------------------------------------------------- 会话

    public record CreateSessionRequest(@NotNull(message = "不能为空") Long workspaceId) {
    }

    public record SessionView(long id, long workspaceId, String title, String createdAt, String updatedAt) {
    }

    public record MessageView(long id, String role, String content, Object meta, String createdAt) {
    }

    /**
     * 发消息。{@code currentFile} 与 {@code selection} 会被注入本轮上下文。
     *
     * @param mode {@code deliver} / {@code teach}；缺省按 deliver 处理
     */
    public record SendMessageRequest(
            @NotBlank(message = "不能为空") @Size(max = 20000, message = "单条消息不能超过 20000 字") String content,
            @Size(max = 1024, message = "路径过长") String currentFile,
            SelectionDto selection,
            @Size(max = 16, message = "取值过长") String mode
    ) {

        public AgentRequest.Selection toSelection() {
            if (selection == null) {
                return null;
            }
            return new AgentRequest.Selection(selection.startLine(), selection.endLine(), selection.text());
        }
    }

    public record SelectionDto(Integer startLine, Integer endLine, String text) {
    }

    public record SendMessageResponse(long messageId, long sessionId) {
    }

    // --------------------------------------------------------- 补丁

    public record PatchView(String id, long sessionId, Long messageId, String file, String diff,
                            String status, String createdAt, String appliedAt) {
    }

    // ------------------------------------------------- 补丁风险条（Blast radius）

    /** 一处代码引用（调用方 / 测试引用），前端渲染成可点击的 `文件:行号`。 */
    public record RefView(String file, int line, String text, String kind) {
    }

    /** 一条风险提示。{@code level} 取 high / medium / low。 */
    public record RiskView(String label, String level, String reason) {
    }

    /**
     * 补丁影响面。用户点「应用」之前先看这个，比只看 diff 更能建立信心。
     */
    public record BlastRadiusView(
            String file,
            String declaredType,
            List<String> changedMembers,
            int addedLines,
            int removedLines,
            List<RefView> callers,
            List<RefView> tests,
            List<RiskView> risks,
            String riskLevel,
            String headline,
            boolean callersTruncated
    ) {
    }

    // --------------------------------------------------------- 编译闭环

    public record CompileIssueView(String file, Integer line, Integer column, String message, String severity) {
    }

    /**
     * 编译结果。
     *
     * @param status ok / failed / timeout / unavailable / disabled
     */
    public record BuildResultView(String status, String buildSystem, String command, Integer exitCode,
                                  long durationMs, String output, List<CompileIssueView> issues, String note) {
    }

    // --------------------------------------------------------- 健康

    public record HealthResponse(String status, boolean modelConfigured, String model, String grepEngine,
                                 boolean redisAvailable) {
    }

    // --------------------------------------------------------- 宪法 / PR 预演

    /** 宪法模板（只返回文本，不落盘）。 */
    public record ConstitutionTemplate(String content) {
    }

    /** 变更预演 PR 的一项审查清单结论。state: ok / warn / bad / info */
    public record PrCheckItem(String text, String state, String detail) {
    }

    /**
     * 变更预演 PR：应用前给用户看的「假如这是一个真正的 PR，它会怎么被描述」。
     *
     * @param title     建议的 PR 标题（约定式前缀）
     * @param branch    建议的分支名（仅命名建议，本产品不建分支）
     * @param body      Markdown 正文：变更内容 / 影响面 / 风险 / 建议验证
     * @param stats     变更统计（files 固定为 1：一个补丁只改一个文件）
     * @param checklist 应用前应逐项过目的审查清单
     */
    public record PrPreviewView(String patchId, String title, String branch, String body,
                                Stats stats, List<PrCheckItem> checklist) {

        public record Stats(int files, int addedLines, int removedLines, int callers, int testFiles) {
        }
    }
}
