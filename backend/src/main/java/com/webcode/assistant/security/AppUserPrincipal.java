package com.webcode.assistant.security;

/**
 * 认证主体。刻意不实现 {@code UserDetails} —— 我们不需要 Spring Security 的
 * 用户加载链路，只需要一个放进 SecurityContext 的身份标识。
 *
 * <p>{@code epoch} 是令牌签发时的<b>会话世代</b>（{@code users.token_epoch}）：
 * 改密 / 强制下线 / 停用 / 降权都会让世代 +1，旧令牌里的世代对不上即刻作废 ——
 * 这是「重置密码后旧 access token 还能再用两小时」的解药。见 {@code JwtAuthenticationFilter}。
 */
public record AppUserPrincipal(long userId, String username, long epoch) {

    @Override
    public String toString() {
        return username + "#" + userId;
    }
}
