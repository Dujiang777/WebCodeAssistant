package com.webcode.assistant.common;

import org.springframework.http.HttpStatus;

/**
 * 统一错误码。前端只依赖 {@code code} 做分支，{@code message} 仅用于展示。
 */
public enum ErrorCode {

    BAD_REQUEST(HttpStatus.BAD_REQUEST, "请求参数不合法"),
    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, "参数校验失败"),
    UNAUTHORIZED(HttpStatus.UNAUTHORIZED, "未登录或登录已过期"),
    FORBIDDEN(HttpStatus.FORBIDDEN, "无权访问该资源"),
    NOT_FOUND(HttpStatus.NOT_FOUND, "资源不存在"),
    CONFLICT(HttpStatus.CONFLICT, "资源冲突"),
    RATE_LIMITED(HttpStatus.TOO_MANY_REQUESTS, "请求过于频繁，请稍后再试"),
    QUOTA_EXCEEDED(HttpStatus.TOO_MANY_REQUESTS, "已达今日用量上限"),

    PATH_ESCAPE(HttpStatus.BAD_REQUEST, "路径超出工作区范围"),
    NOT_A_DIRECTORY(HttpStatus.BAD_REQUEST, "目标不是目录"),
    NOT_A_FILE(HttpStatus.BAD_REQUEST, "目标不是文件"),
    FILE_TOO_LARGE(HttpStatus.PAYLOAD_TOO_LARGE, "文件过大"),
    WORKSPACE_TOO_LARGE(HttpStatus.PAYLOAD_TOO_LARGE, "工作区体积超出上限"),
    ARCHIVE_INVALID(HttpStatus.BAD_REQUEST, "压缩包不合法或已损坏"),

    DIFF_INVALID(HttpStatus.BAD_REQUEST, "补丁格式无法解析"),
    DIFF_CONFLICT(HttpStatus.CONFLICT, "补丁上下文与当前文件不匹配，文件可能已被修改"),
    PATCH_ALREADY_RESOLVED(HttpStatus.CONFLICT, "该补丁已被应用或拒绝"),
    FLAG_ACK_REQUIRED(HttpStatus.CONFLICT, "该补丁改动了行为，必须先确认特性开关关闭时的旧路径才能应用"),

    LLM_ERROR(HttpStatus.BAD_GATEWAY, "模型服务调用失败"),
    LLM_NOT_CONFIGURED(HttpStatus.SERVICE_UNAVAILABLE, "未配置模型服务，请检查 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL"),
    CLONE_FAILED(HttpStatus.BAD_GATEWAY, "仓库克隆失败"),

    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "服务器内部错误");

    private final HttpStatus status;
    private final String defaultMessage;

    ErrorCode(HttpStatus status, String defaultMessage) {
        this.status = status;
        this.defaultMessage = defaultMessage;
    }

    public HttpStatus status() {
        return status;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}
