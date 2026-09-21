package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiError;
import com.webcode.assistant.common.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

import java.io.IOException;

/**
 * 把 Spring Security 的 401 / 403 也写成统一错误体，避免前端要区分两种错误格式。
 */
@Component
public final class AuthErrorWriter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private AuthErrorWriter() {
    }

    static void write(HttpServletResponse response, int status, ErrorCode code) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        MAPPER.writeValue(response.getWriter(), ApiError.of(code));
    }
}
