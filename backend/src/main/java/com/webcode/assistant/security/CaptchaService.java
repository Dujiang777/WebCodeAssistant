package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.mail.MailService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 注册 / 找回密码的图形验证码。
 *
 * <p>为什么这两个接口要验证码：它们匿名可达且产生副作用（建号、发信），
 * 是脚本刷号与邮件轰炸的天然入口；登录不需要（有账号级失败锁定）。
 *
 * <p>答案的存储与 {@code UsageGuard} 同一套降级策略：Redis 是真源
 * （{@code wca:captcha:{id}}，带 TTL，多实例共享），连不上时降级为进程内
 * {@link ConcurrentHashMap}（自清过期项）。验证即消费 —— 一个验证码只能用一次，
 * 防止同一个答案被脚本反复提交。
 *
 * <p>dev 模式（{@link MailService#echoTokens()}）下答案随接口明文返回：
 * 与「dev 模式回显验证链接」是同一条设计决策 —— 本地和自检脚本没有真邮箱，
 * 图片里的字符脚本也认不出来，不回显整条注册链路就断在第一格。
 * 该开关在生产（MAIL_MODE=smtp）下恒为 false，不存在泄漏面。
 */
@Service
public class CaptchaService {

    private static final Logger log = LoggerFactory.getLogger(CaptchaService.class);

    /** 字符集刻意去掉 0/O、1/l/I —— 人眼分不清的验证码只会逼用户无限刷新。 */
    private static final String ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
    private static final int CODE_LENGTH = 4;
    /** 一个验证码最多允许的验证尝试次数：防同一个 id 被脚本逐字符爆破。 */
    private static final int MAX_ATTEMPTS = 5;

    private final StringRedisTemplate redis;
    private final MailService mailService;
    private final Duration ttl;
    private final boolean enabled;

    private final Map<String, Entry> localStore = new ConcurrentHashMap<>();

    private record Entry(String answer, long expiresAt, int attempts) {
    }

    public CaptchaService(StringRedisTemplate redis, MailService mailService, AppProperties properties) {
        this.redis = redis;
        this.mailService = mailService;
        this.ttl = properties.auth().captchaTtl();
        this.enabled = properties.auth().captchaEnabled();
    }

    /** 验证码是否启用。关闭时前端不渲染验证码控件，后端跳过校验。 */
    public boolean enabled() {
        return enabled;
    }

    public Challenge issue() {
        if (!enabled) {
            return new Challenge("", "", null);
        }
        String answer = randomCode();
        String id = UUID.randomUUID().toString();
        long expiresAt = System.currentTimeMillis() + ttl.toMillis();
        store(id, answer, expiresAt);
        return new Challenge(id, render(answer), mailService.echoTokens() ? answer : null);
    }

    /** 校验并消费。无论对错都扣一次尝试次数；答对或次数耗尽即失效。 */
    public void verifyAndConsume(String captchaId, String code) {
        if (!enabled) {
            return;
        }
        if (captchaId == null || captchaId.isBlank() || code == null || code.isBlank()) {
            throw new ApiException(ErrorCode.CAPTCHA_INVALID);
        }
        String normalized = code.trim().toLowerCase();
        Entry entry = load(captchaId);
        if (entry == null || System.currentTimeMillis() > entry.expiresAt()) {
            remove(captchaId);
            throw new ApiException(ErrorCode.CAPTCHA_INVALID);
        }
        if (entry.attempts() >= MAX_ATTEMPTS) {
            remove(captchaId);
            throw new ApiException(ErrorCode.CAPTCHA_INVALID);
        }
        if (!entry.answer().equals(normalized)) {
            store(captchaId, entry.answer(), entry.expiresAt(), entry.attempts() + 1);
            throw new ApiException(ErrorCode.CAPTCHA_INVALID);
        }
        remove(captchaId);
    }

    /** 对外视图。{@code devAnswer} 仅 dev 模式非空（见类注释）。 */
    public record Challenge(String id, String imagePngBase64, String devAnswer) {
    }

    // ------------------------------------------------------------- 存取（Redis + 进程内降级）

    private void store(String id, String answer, long expiresAt) {
        store(id, answer, expiresAt, 0);
    }

    private void store(String id, String answer, long expiresAt, int attempts) {
        Entry entry = new Entry(answer, expiresAt, attempts);
        // Redis 只存字符串，编码成 "answer:attempts:expiresAt"：
        // 次数要跨实例防爆破，过期时间要跟着走（失败重存时不能把 TTL 重置成天文数字）
        String value = answer + ":" + attempts + ":" + expiresAt;
        try {
            redis.opsForValue().set(key(id), value,
                    Duration.ofMillis(Math.max(1, Math.min(expiresAt - System.currentTimeMillis(), ttl.toMillis()))));
            return;
        } catch (RuntimeException ex) {
            log.debug("Redis 不可用，验证码降级为进程内存储: {}", ex.getMessage());
        }
        localStore.put(id, entry);
    }

    private Entry load(String id) {
        try {
            String value = redis.opsForValue().get(key(id));
            if (value != null) {
                String[] parts = value.split(":", 3);
                if (parts.length == 3) {
                    try {
                        return new Entry(parts[0], Long.parseLong(parts[2]), Integer.parseInt(parts[1]));
                    } catch (NumberFormatException ignored) {
                        // 落到下面的解析失败兜底
                    }
                }
                return new Entry(value, Long.MAX_VALUE, 0);
            }
        } catch (RuntimeException ex) {
            log.debug("Redis 不可用，验证码读取走进程内: {}", ex.getMessage());
        }
        Entry entry = localStore.get(id);
        if (entry != null && System.currentTimeMillis() > entry.expiresAt()) {
            localStore.remove(id);
            return null;
        }
        return entry;
    }

    private void remove(String id) {
        try {
            redis.delete(key(id));
        } catch (RuntimeException ignored) {
            // Redis 挂时进程内副本会在读取时按过期时间自清
        }
        localStore.remove(id);
    }

    private static String key(String id) {
        return "wca:captcha:" + id;
    }

    private static String randomCode() {
        Random random = new Random();
        StringBuilder sb = new StringBuilder(CODE_LENGTH);
        for (int i = 0; i < CODE_LENGTH; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    // ------------------------------------------------------------- 画图

    /**
     * 4 字符 + 干扰线 + 逐字符随机旋转/颜色。不引入任何第三方依赖 ——
     * 验证码的强度来自「答案只存服务端 + 单次消费」，不来自图片多难认。
     */
    private static String render(String answer) {
        int width = 128;
        int height = 44;
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new Color(0x0b, 0x0a, 0x08));
            g.fillRect(0, 0, width, height);

            Random random = new Random();
            // 干扰线
            for (int i = 0; i < 5; i++) {
                g.setColor(new Color(60 + random.nextInt(50), 55 + random.nextInt(45), 40 + random.nextInt(40)));
                g.setStroke(new BasicStroke(1f));
                g.drawLine(random.nextInt(width), random.nextInt(height),
                        random.nextInt(width), random.nextInt(height));
            }
            // 字符
            Font[] fonts = {
                    new Font("SansSerif", Font.BOLD, 26),
                    new Font("Monospaced", Font.BOLD, 25),
                    new Font("Serif", Font.BOLD, 26),
            };
            Color[] colors = {
                    new Color(0xe8, 0xb4, 0x5a), new Color(0xf2, 0xec, 0xde),
                    new Color(0xb4, 0x8c, 0xff), new Color(0x61, 0xdc, 0x9d),
            };
            int charWidth = (width - 24) / CODE_LENGTH;
            for (int i = 0; i < CODE_LENGTH; i++) {
                double theta = (random.nextDouble() - 0.5) * 0.6;
                g.setFont(fonts[random.nextInt(fonts.length)]);
                g.setColor(colors[random.nextInt(colors.length)]);
                int x = 12 + i * charWidth;
                int y = height / 2 + 9 + random.nextInt(5) - 2;
                g.rotate(theta, x, y);
                g.drawString(String.valueOf(answer.charAt(i)), x, y);
                g.rotate(-theta, x, y);
            }
            // 前景噪点
            for (int i = 0; i < 40; i++) {
                g.setColor(new Color(40 + random.nextInt(60), 40 + random.nextInt(50), 35 + random.nextInt(45)));
                g.fillRect(random.nextInt(width), random.nextInt(height), 1, 1);
            }
        } finally {
            g.dispose();
        }
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            return Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (Exception ex) {
            throw new IllegalStateException("生成验证码图片失败", ex);
        }
    }
}
