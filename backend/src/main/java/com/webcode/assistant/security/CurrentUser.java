package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * 从 SecurityContext 中取当前登录用户。控制器与服务层统一通过它拿 userId，
 * 避免各自去碰 SecurityContextHolder。
 */
@Component
public class CurrentUser {

    public AppUserPrincipal require() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof AppUserPrincipal principal)) {
            throw new ApiException(ErrorCode.UNAUTHORIZED);
        }
        return principal;
    }

    public long requireId() {
        return require().userId();
    }
}
