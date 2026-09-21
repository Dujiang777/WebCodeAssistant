package com.webcode.assistant.security;

/**
 * 认证主体。刻意不实现 {@code UserDetails} —— 我们不需要 Spring Security 的
 * 用户加载链路，只需要一个放进 SecurityContext 的身份标识。
 */
public record AppUserPrincipal(long userId, String username) {

    @Override
    public String toString() {
        return username + "#" + userId;
    }
}
