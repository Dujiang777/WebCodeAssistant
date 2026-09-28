package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiError;
import com.webcode.assistant.common.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 解析 {@code Authorization: Bearer <jwt>}，成功则把身份写入 SecurityContext。
 * 解析失败不在这里报错，交给 SecurityConfig 的 entryPoint 统一返回 401 JSON。
 */
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final String PREFIX = "Bearer ";

    private final JwtService jwtService;
    private final ObjectMapper objectMapper;
    private final AccountStatusGuard statusGuard;

    public JwtAuthenticationFilter(JwtService jwtService, ObjectMapper objectMapper,
                                   AccountStatusGuard statusGuard) {
        this.jwtService = jwtService;
        this.objectMapper = objectMapper;
        this.statusGuard = statusGuard;
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith(PREFIX)) {
            chain.doFilter(request, response);
            return;
        }

        String token = header.substring(PREFIX.length()).trim();
        var principal = jwtService.parse(token);
        if (principal.isEmpty()) {
            writeUnauthorized(response);
            return;
        }
        long userId = principal.get().userId();

        // 一次快检同时处理两个「无状态令牌挡不住处置」的漏洞：
        //
        //   1) 停用：账号被停用后，手上那张未过期的 access token 依然畅通 ——
        //      403 而不是 401，前端据此知道「不是掉线了，别去刷新令牌」；
        //
        //   2) 会话世代：改密 / 强制下线 / 重置密码 / 降权都会让 users.token_epoch +1，
        //      令牌里签发时的世代对不上当前世代 = 这张令牌已被处置作废 ——
        //      这是 401（令牌本身已无效），前端应走刷新或重新登录。
        //      epoch 为 null 只在数据库抖动时出现，state() 已按放行处理。
        var state = statusGuard.state(userId);
        if (state.disabled()) {
            writeDisabled(response);
            return;
        }
        if (state.epoch() != null && principal.get().epoch() != state.epoch()) {
            writeTokenInvalid(response);
            return;
        }

        var authentication = new UsernamePasswordAuthenticationToken(
                principal.get(), null, List.of(new SimpleGrantedAuthority("ROLE_USER")));
        authentication.setDetails(request.getRequestURI());
        SecurityContextHolder.getContext().setAuthentication(authentication);
        chain.doFilter(request, response);
    }

    private void writeUnauthorized(HttpServletResponse response) throws IOException {
        write(response, HttpServletResponse.SC_UNAUTHORIZED, ErrorCode.UNAUTHORIZED);
    }

    /** 403 而不是 401：前端据此知道「不是掉线了，别去刷新令牌」。 */
    private void writeDisabled(HttpServletResponse response) throws IOException {
        write(response, HttpServletResponse.SC_FORBIDDEN, ErrorCode.ACCOUNT_DISABLED);
    }

    /** 令牌被处置动作作废（世代对不上）：401，前端清掉本地令牌走刷新/重登。 */
    private void writeTokenInvalid(HttpServletResponse response) throws IOException {
        write(response, HttpServletResponse.SC_UNAUTHORIZED, ErrorCode.TOKEN_INVALID);
    }

    private void write(HttpServletResponse response, int status, ErrorCode code) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(response.getWriter(), ApiError.of(code));
    }
}
