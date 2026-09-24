package com.webcode.assistant.api;

import com.webcode.assistant.agent.AgentRequest;
import com.webcode.assistant.workspace.Workspace;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;

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

    /**
     * 注册。
     *
     * <p>邮箱是<b>必填</b>：找回密码、登录异常通知、风控都依赖它，
     * 一个没有邮箱的账号在上线产品里是「找不回来的账号」。
     * 哈希长度下限 8（且需含字母与数字）由服务端统一校验，注解这里只管长度。
     */
    public record RegisterRequest(
            @NotBlank(message = "不能为空") @Size(min = 3, max = 64, message = "长度需在 3-64 之间") String username,
            @NotBlank(message = "不能为空") @Size(max = 160, message = "长度不能超过 160") String email,
            @NotBlank(message = "不能为空") @Size(min = 8, max = 128, message = "长度需在 8-128 之间") String password
    ) {
    }

    /** 登录。{@code username} 一个框同时收用户名和邮箱，字段名保持向后兼容。 */
    public record LoginRequest(
            @NotBlank(message = "不能为空") String username,
            @NotBlank(message = "不能为空") String password
    ) {
    }

    /** 用 refresh 换新令牌，或退出登录时带上它。 */
    public record RefreshRequest(String refreshToken) {
    }

    /**
     * 认证成功返回体。
     *
     * <p>{@code devVerifyToken} 只在 {@code MAIL_MODE=dev} 时非空 ——
     * 本地没有真实邮箱，不回显令牌的话「验证邮箱」这条链路根本无法测试。
     * 线上由 {@code SmtpMailService} 硬编码返回 null。
     */
    public record AuthResponse(long userId, String username, String email, boolean emailVerified,
                               String role, String accessToken, String refreshToken,
                               long accessTokenExpiresIn, long refreshTokenExpiresIn,
                               long credits, boolean lowBalance, String devVerifyToken) {
    }

    /** 当前用户 + 积分概览。前端启动时拉一次，顶栏的积分徽标就靠它。 */
    public record MeResponse(long userId, String username, String email, boolean emailVerified,
                             String role, long credits, boolean lowBalance, boolean enforceBalance,
                             long lowBalanceThreshold, String pricingNote, boolean mailEchoTokens) {
    }

    /** 邮箱验证 / 重置密码这类「发一封信」的接口返回体。 */
    public record DispatchResponse(boolean sent, String target, String devToken) {
    }

    public record VerifyEmailRequest(@NotBlank(message = "不能为空") String token) {
    }

    /** 找回密码。无论邮箱是否存在都返回 sent=true（防账号枚举），页面上会写明这一点。 */
    public record ForgotPasswordRequest(
            @NotBlank(message = "不能为空") @Size(max = 160, message = "长度不能超过 160") String email
    ) {
    }

    public record ResetPasswordRequest(
            @NotBlank(message = "不能为空") String token,
            @NotBlank(message = "不能为空") @Size(min = 8, max = 128, message = "长度需在 8-128 之间") String password
    ) {
    }

    public record ChangePasswordRequest(
            @NotBlank(message = "不能为空") String oldPassword,
            @NotBlank(message = "不能为空") @Size(min = 8, max = 128, message = "长度需在 8-128 之间") String newPassword
    ) {
    }

    /**
     * 登录设备。刻意不含令牌本身，只给「能认出这是不是我」的最小信息。
     *
     * <p>名字带 {@code Login} 前缀是为了跟对话会话的 {@code SessionView} 区分开 ——
     * 两个「Session」完全不是一回事（一个是登录态，一个是聊天会话），
     * 重名会让读代码的人每次都要回头确认。
     */
    public record LoginSessionView(long id, String device, String ip, String createdAt, String expiresAt) {
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

    // --------------------------------------------------------- 闸门 / 特性开关 / What-if

    /**
     * 「已确认特性开关的关闭路径」标记（功能 16）。
     *
     * <p>刻意做成显式字段而不是省略：省略掉就等于没确认，后端会 409。
     * 这个布尔值就是「我看过关掉开关之后跑哪条旧路径」这句话的机器可读形式。
     */
    public record FlagAckRequest(boolean acknowledgeFlag) {
    }

    /** 工具闸门审批：放行时可带上改过的参数（只覆盖工具自己声明的键）。 */
    public record GateApproveRequest(Map<String, Object> args, String note) {
    }

    /** 工具闸门拒绝。 */
    public record GateRejectRequest(String note) {
    }

    /** 闸门策略：off（全放行）/ writes（拦写操作，默认）/ strict（再拦大范围检索）。 */
    public record GatePolicyRequest(String policy) {
    }

    /** 开一次 What-if 实验。 */
    public record WhatIfRequest(long sessionId, String question, String file) {
    }

    // --------------------------------------------------------------- 积分 / 计费

    /**
     * 积分概览。
     *
     * <p>把计价规则（{@code pricingNote}）一并下发，而不是让前端自己拼文案 ——
     * 单价是后端的配置，前端复制一份就等于有了两个真相源，改价时必然漏一处。
     */
    public record CreditSummaryResponse(long balance, long totalGranted, long totalConsumed,
                                        boolean lowBalance, boolean enforceBalance, long lowBalanceThreshold,
                                        long holdCredits, long signupBonus, String pricingNote) {
    }

    /** 流水条目。{@code delta} 正数入账、负数出账；{@code balanceAfter} 是这一笔之后的余额。 */
    public record LedgerEntryView(long id, String kind, long delta, long balanceAfter, String reason,
                                  String refType, String refId, String createdAt) {
    }

    public record LedgerResponse(List<LedgerEntryView> items, long total) {
    }

    /** 套餐视图。{@code totalCredits} 与 {@code centsPerKiloCredit} 由后端算好，前端只负责显示。 */
    public record CreditPlanView(String code, String name, int priceCents, long credits, long bonusCredits,
                                 long totalCredits, long centsPerKiloCredit, String tag, String description) {
    }

    public record OrderView(String orderNo, String planCode, int amountCents, long credits, String status,
                            String provider, String createdAt, String paidAt) {
    }

    /** 下单结果：订单 + 支付参数（真实通道是二维码内容或跳转 URL）。 */
    public record OrderResponse(OrderView order, Map<String, Object> payment) {
    }

    /** 对账结果。{@code consistent=false} 表示账户快照与账本累计值对不上，属于必须排查的 bug。 */
    public record ReconcileResponse(long balance, long ledgerSum, boolean consistent) {
    }

    public record CreateOrderRequest(@NotBlank(message = "不能为空") String planCode) {
    }

    /** 支付确认（回调形状）。{@code payToken} 模拟真实通道的支付凭证。 */
    public record PayOrderRequest(@NotBlank(message = "不能为空") String payToken) {
    }

    /** 管理端：手动调整某人积分。 */
    public record AdjustCreditRequest(@NotNull(message = "不能为空") Long userId,
                                      @NotNull(message = "不能为空") Long amount,
                                      @Size(max = 200, message = "长度不能超过 200") String reason) {
    }

    /** 管理端：账号视图，顺带带上账本累计值，便于直接看出「快照与账本是否一致」。 */
    public record AdminAccountView(long userId, String username, String email, String role, String status,
                                   long balance, long totalGranted, long totalConsumed,
                                   long ledgerSum, boolean consistent) {
    }
}
