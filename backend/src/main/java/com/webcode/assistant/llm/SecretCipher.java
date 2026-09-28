package com.webcode.assistant.llm;

import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 用户自带 API Key 的本地加密（AES-256-GCM）。
 *
 * <p>为什么必须加密而不是哈希：哈希是不可逆的，但平台<b>需要拿回明文</b>去调模型服务。
 * 所以这里用的是可逆加密；它的防线是「数据库被单独拖走时密钥不泄漏」——
 * 攻击者还得同时拿到 {@code APP_SECRET} 才有意义。
 *
 * <p>为什么是 GCM 而不是 CBC：GCM 自带完整性校验。CBC 下的密文可以被静默篡改，
 * 解出来是一段垃圾密钥，表现成「模型一直 401」这种极难排查的故障。
 *
 * <p>密钥派生：{@code APP_SECRET}（缺失时回退 {@code JWT_SECRET}）做 SHA-256，
 * 得到固定的 32 字节。不引入额外 KDF 的理由是 —— 这里的输入来自运维配置的高熵字符串，
 * 不是用户口令，暴力破解不成立。
 *
 * <p>存储格式：{@code v1:base64(iv || ciphertext)}。带版本前缀是为了将来换算法时
 * 能识别老密文，而不是只能「全部重新填一遍」。
 */
@Component
public class SecretCipher {

    private static final Logger log = LoggerFactory.getLogger(SecretCipher.class);

    private static final String PREFIX = "v1:";
    private static final int IV_BYTES = 12;          // GCM 推荐 96 位
    private static final int TAG_BITS = 128;

    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    public SecretCipher(AppProperties properties) {
        String raw = properties.secrets().secretKey();
        if (raw == null || raw.isBlank()) {
            // 回退到 JWT_SECRET：本地开发不必多配一个变量。注意这两个值的生命周期不同，
            // 换 JWT 密钥会让已存的模型 Key 解不开 —— 日志里明确警告一次，免得后面莫名其妙。
            log.warn("APP_SECRET 未配置，模型密钥加密回退使用 JWT_SECRET；"
                    + "生产环境请单独设置 APP_SECRET，否则轮换 JWT 密钥会导致已保存的模型 Key 无法解密");
            raw = properties.jwt().secret();
        }
        this.key = new SecretKeySpec(sha256(raw), "AES");
    }

    /** 加密。空值原样返回 null —— 「用户没填 Key」不是错误，只是他的模型用不了。 */
    public String encrypt(String plain) {
        if (plain == null || plain.isBlank()) {
            return null;
        }
        try {
            byte[] iv = new byte[IV_BYTES];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));

            byte[] combined = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
            return PREFIX + Base64.getEncoder().encodeToString(combined);
        } catch (Exception ex) {
            throw new IllegalStateException("模型密钥加密失败", ex);
        }
    }

    /**
     * 解密。
     *
     * <p>解不开时<b>返回 null 而不是抛异常</b>：最常见的场景是运维换了 {@code APP_SECRET}，
     * 此时正确的行为是「这个用户的模型暂时不可用、请重新填一次 Key」，
     * 而不是让整个模型列表接口 500 —— 一个用户的历史密钥不该拖垮所有人。
     */
    public String decrypt(String stored) {
        if (stored == null || stored.isBlank()) {
            return null;
        }
        if (!stored.startsWith(PREFIX)) {
            // 兼容未来/手工写入的裸值：不当作密文，直接返回，避免把明文当密文解密炸掉
            return stored;
        }
        try {
            byte[] combined = Base64.getDecoder().decode(stored.substring(PREFIX.length()));
            byte[] iv = new byte[IV_BYTES];
            System.arraycopy(combined, 0, iv, 0, IV_BYTES);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] plain = cipher.doFinal(combined, IV_BYTES, combined.length - IV_BYTES);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception ex) {
            log.warn("模型密钥解密失败（多半是 APP_SECRET/JWT_SECRET 被轮换过），该模型将被视为未配置", ex);
            return null;
        }
    }

    /**
     * 生成给界面看的密钥尾号提示。
     *
     * <p>只留前 3 后 4：足够用户确认「填的是哪一把」，又不足以拼回原值。
     * 短于 12 位的密钥一律整体打码 —— 太短的串首尾一露等于露全了。
     */
    public String hint(String plain) {
        if (plain == null || plain.isBlank()) {
            return null;
        }
        String trimmed = plain.trim();
        if (trimmed.length() < 12) {
            return "****";
        }
        return trimmed.substring(0, 3) + "****" + trimmed.substring(trimmed.length() - 4);
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 不可用", ex);
        }
    }
}
