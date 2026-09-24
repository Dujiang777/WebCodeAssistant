package com.webcode.assistant.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

/**
 * 一次性令牌的生成与摘要。
 *
 * <p>为什么邮件令牌和刷新令牌都只存摘要：这两类令牌等价于「免密凭证」——
 * 拿到就能改密码 / 拿到就能长期冒充。数据库不是绝对安全的地方（备份、日志、
 * 只读账号、误操作导出都可能泄露），所以库里只留 sha256 摘要，
 * 泄露了也换不回一个可用的令牌。
 *
 * <p>为什么不用 BCrypt（密码用的是它）：令牌是 256 位高熵随机串，不存在
 * 「弱口令被字典撞开」的问题，不需要加盐和慢哈希；而令牌校验在热路径上
 * （每次刷新都要查一次），慢哈希会平白增加延迟。摘要用 sha256 足够。
 */
public final class Tokens {

    /** 32 字节熵 → base64url 43 字符，足够抵抗暴力枚举。 */
    private static final int TOKEN_BYTES = 32;

    private static final SecureRandom RANDOM = new SecureRandom();

    private Tokens() {
    }

    /** 生成一个新的原始令牌（下发给客户端的那一份，库里不存它）。 */
    public static String newRaw() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** 令牌摘要，落库用。输出 64 字符十六进制，正好对上 {@code char(64)} 列。 */
    public static String hash(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            // SHA-256 是 JDK 必备算法，走不到这里；真走到了说明 JRE 被裁剪过，必须炸出来
            throw new IllegalStateException("当前 JRE 不支持 SHA-256", ex);
        }
    }

    /** 常量时间比较，避免用 {@code equals} 比摘要时泄露长度/前缀信息。 */
    public static boolean matches(String raw, String expectedHash) {
        if (raw == null || expectedHash == null) {
            return false;
        }
        return MessageDigest.isEqual(
                hash(raw).getBytes(StandardCharsets.UTF_8),
                expectedHash.getBytes(StandardCharsets.UTF_8));
    }
}
