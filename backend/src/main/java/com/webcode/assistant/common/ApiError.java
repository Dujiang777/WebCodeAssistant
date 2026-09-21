package com.webcode.assistant.common;

/**
 * 统一错误响应体：{@code { "code": "...", "message": "..." }}。
 */
public record ApiError(String code, String message) {

    public static ApiError of(ErrorCode code, String message) {
        return new ApiError(code.name(), message == null || message.isBlank() ? code.defaultMessage() : message);
    }

    public static ApiError of(ErrorCode code) {
        return new ApiError(code.name(), code.defaultMessage());
    }
}
