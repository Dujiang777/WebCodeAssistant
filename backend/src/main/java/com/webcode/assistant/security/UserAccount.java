package com.webcode.assistant.security;

import java.time.Instant;

/**
 * 用户读模型（不承载任何鉴权逻辑，只做数据搬运）。
 *
 * <p>{@code email} 与 {@code emailVerified} 都可空/可假：存量账号和演示账号没有邮箱，
 * 商业级不等于「必须人人有邮箱」，而是「有邮箱的走验证，没邮箱的不受影响」。
 *
 * <p>{@code lockedUntil} 是瞬时值而不是布尔：锁定的判据是
 * 「当前时间 &lt; lockedUntil」，这样「到点自动解锁」不需要任何定时任务。
 */
public record UserAccount(
        long id,
        String username,
        String email,
        boolean emailVerified,
        String passwordHash,
        String role,
        String status,
        int failedAttempts,
        Instant lockedUntil,
        Instant lastLoginAt,
        Instant createdAt
) {

    public static final String ROLE_USER = "USER";
    public static final String ROLE_ADMIN = "ADMIN";
    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_DISABLED = "DISABLED";

    public boolean admin() {
        return ROLE_ADMIN.equals(role);
    }

    public boolean active() {
        return STATUS_ACTIVE.equals(status);
    }

    /** 此刻是否处于锁定窗口内。{@code lockedUntil} 为空表示从未锁定。 */
    public boolean lockedNow() {
        return lockedUntil != null && Instant.now().isBefore(lockedUntil);
    }
}
