package com.webcode.assistant.security;

import java.time.Instant;

/**
 * 用户读模型（不承载任何鉴权逻辑，只做数据搬运）。
 */
public record UserAccount(long id, String username, String passwordHash, Instant createdAt) {
}
