package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.regex.Pattern;

/**
 * 注册 / 登录。第一期就带完整校验，避免后面接第三方登录时回头补。
 */
@Service
public class AuthService {

    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[A-Za-z0-9_.-]{3,64}$");
    private static final int MIN_PASSWORD_LENGTH = 6;
    private static final int MAX_PASSWORD_LENGTH = 128;

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder, JwtService jwtService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
    }

    @Transactional
    public AuthResult register(String rawUsername, String rawPassword) {
        String username = normalizeUsername(rawUsername);
        validatePassword(rawPassword);

        if (userRepository.existsByUsername(username)) {
            throw new ApiException(ErrorCode.CONFLICT, "用户名已被占用");
        }
        long userId;
        try {
            userId = userRepository.insert(username, passwordEncoder.encode(rawPassword));
        } catch (DuplicateKeyException ex) {
            // 并发注册同名用户时唯一索引兜底
            throw new ApiException(ErrorCode.CONFLICT, "用户名已被占用");
        }
        return new AuthResult(userId, username, jwtService.issue(userId, username), jwtService.ttlSeconds());
    }

    @Transactional(readOnly = true)
    public AuthResult login(String rawUsername, String rawPassword) {
        String username = rawUsername == null ? "" : rawUsername.trim();
        UserAccount account = userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "用户名或密码错误"));

        if (!passwordEncoder.matches(rawPassword == null ? "" : rawPassword, account.passwordHash())) {
            // 不区分「用户不存在」与「密码错误」，避免用户名枚举
            throw new ApiException(ErrorCode.UNAUTHORIZED, "用户名或密码错误");
        }
        return new AuthResult(account.id(), account.username(),
                jwtService.issue(account.id(), account.username()), jwtService.ttlSeconds());
    }

    private String normalizeUsername(String rawUsername) {
        String username = rawUsername == null ? "" : rawUsername.trim();
        if (!USERNAME_PATTERN.matcher(username).matches()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "用户名需为 3-64 位的字母、数字、下划线、点或短横线");
        }
        return username;
    }

    private void validatePassword(String rawPassword) {
        int length = rawPassword == null ? 0 : rawPassword.length();
        if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "密码长度需在 " + MIN_PASSWORD_LENGTH + "-" + MAX_PASSWORD_LENGTH + " 之间");
        }
    }

    /** 登录成功后的返回体。 */
    public record AuthResult(long userId, String username, String token, long expiresInSeconds) {
    }
}
