package com.webcode.assistant.mail;

import com.webcode.assistant.config.AppProperties;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;

/**
 * SMTP 邮件通道（{@code MAIL_MODE=smtp} 时生效）。
 *
 * <p>两个刻意的决定：
 * <ul>
 *   <li><b>同步发送，失败就报错。</b>异步发信看起来更快，但用户点完「发送验证邮件」
 *       会立刻去翻邮箱，如果发信失败而接口回了 200，他只会以为「邮件被吞了」，
 *       然后反复重试 —— 那才是真正的坏体验。宁可让这次请求慢 1 秒并如实报错。</li>
 *   <li><b>{@link #echoTokens()} 硬编码 false。</b>线上把令牌回显出来等于
 *       「输入任意已注册邮箱即可改密」，这种事不该留一个配置开关给人配错。</li>
 * </ul>
 */
@Service
@ConditionalOnProperty(name = "app.mail.mode", havingValue = "smtp")
public class SmtpMailService implements MailService {

    private static final Logger log = LoggerFactory.getLogger(SmtpMailService.class);

    private final JavaMailSender sender;
    private final AppProperties properties;

    public SmtpMailService(JavaMailSender sender, AppProperties properties) {
        this.sender = sender;
        this.properties = properties;
    }

    @Override
    public String mode() {
        return "smtp";
    }

    @Override
    public boolean echoTokens() {
        return false;
    }

    @Override
    public void sendVerifyEmail(String to, String username, String link) {
        send(to, "验证你的邮箱 · Web Code Assistant",
                "你好 " + username + "：\n\n点击下面的链接完成邮箱验证（"
                        + properties.auth().tokenTtl().toMinutes() + " 分钟内有效）：\n"
                        + link + "\n\n如果这不是你本人的操作，忽略本邮件即可。",
                link, "验证邮箱", username,
                "验证之后，AI 对话、补丁应用这些能力才会对你完全放开。");
    }

    @Override
    public void sendResetPassword(String to, String username, String link) {
        send(to, "重置密码 · Web Code Assistant",
                "你好 " + username + "：\n\n有人请求重置这个账号的密码。"
                        + properties.auth().tokenTtl().toMinutes() + " 分钟内点击下面的链接可以设置新密码：\n"
                        + link + "\n\n如果这不是你本人的操作，请忽略本邮件，你的密码不会改变。",
                link, "设置新密码", username,
                "链接只能用一次，用完即失效。");
    }

    private void send(String to, String subject, String text, String link,
                      String action, String username, String footNote) {
        try {
            MimeMessage message = sender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, false, StandardCharsets.UTF_8.name());
            helper.setFrom(properties.mail().from());
            helper.setTo(to);
            helper.setSubject(subject);
            // 纯文本必须给：不少企业邮箱和手机端默认只渲染 text/plain，
            // 只发 HTML 会让一部分用户看到空白邮件。
            helper.setText(text, html(username, action, link, footNote));
            sender.send(message);
            log.info("已发送邮件 to={} subject={}", to, subject);
        } catch (Exception ex) {
            // 包装成运行期异常，交给 GlobalExceptionHandler 统一转 500/502。
            // 这里绝不能吞掉 —— 吞掉就等于「验证邮件没发出去但用户以为发了」。
            throw new IllegalStateException("发送邮件失败：" + ex.getMessage(), ex);
        }
    }

    /**
     * 内联样式的 HTML 版。
     *
     * <p>刻意不用 {@code <style>} 和外部 CSS：Gmail、Outlook、企业邮箱的渲染器
     * 大多会把这部分直接剥掉，只有内联 style 属性是可靠的。
     */
    private String html(String username, String action, String link, String footNote) {
        return """
                <div style="margin:0;padding:32px 16px;background:#0b0a08;font-family:-apple-system,'Segoe UI',sans-serif;">
                  <div style="max-width:520px;margin:0 auto;background:#141210;border:1px solid #2a2620;border-radius:12px;padding:28px;">
                    <div style="color:#e8b45a;font-size:12px;letter-spacing:.14em;font-weight:700;">WEB CODE ASSISTANT</div>
                    <h1 style="margin:18px 0 10px;color:#f5f1e8;font-size:19px;font-weight:600;">%s</h1>
                    <p style="margin:0 0 22px;color:#a49c8c;font-size:13.5px;line-height:1.7;">
                      你好 %s，点击下面的按钮完成操作。链接只能用一次。
                    </p>
                    <a href="%s" style="display:inline-block;padding:11px 22px;background:#e8b45a;color:#1a1508;border-radius:999px;text-decoration:none;font-size:13.5px;font-weight:600;">%s</a>
                    <p style="margin:22px 0 0;color:#6f6759;font-size:12px;line-height:1.7;">
                      %s<br>如果按钮点不动，把下面这段地址整条复制到浏览器打开：<br>
                      <span style="color:#a49c8c;word-break:break-all;">%s</span>
                    </p>
                  </div>
                </div>
                """.formatted(action, username, link, action, footNote, link);
    }
}
