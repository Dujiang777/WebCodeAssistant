package com.demo;

/**
 * 用户不存在。领域异常，由控制器统一转成 404。
 */
public class UserNotFoundException extends RuntimeException {

    private final Long userId;

    public UserNotFoundException(Long userId) {
        super("用户不存在: " + userId);
        this.userId = userId;
    }

    public Long getUserId() {
        return userId;
    }
}
