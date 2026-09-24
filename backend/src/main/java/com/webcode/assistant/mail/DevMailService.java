package com.webcode.assistant.mail;

import com.webcode.assistant.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/**
 * 开发模式邮件通道：不发信，只把链接写进日志。
 *
 * <p>它存在的意义不是「偷懒」，而是让邮箱验证 / 找回密码这两条链路
 * <b>在没有 SMTP 账号的机器上也能被完整地测试</b>。如果只有 SMTP 实现，
 * 这两条最关键的安全链路会长期处于「写完没人跑过」的状态。
 *
 * <p>配套的是 {@link #echoTokens()} 返回 true：令牌会随接口响应返回，
 * 自检脚本因此可以全流程跑通（注册 → 拿验证令牌 → 验证 → 找回 → 重置 → 用新密码登录）。
 */
@Service
@ConditionalOnProperty(name = "app.mail.mode", havingValue = "dev", matchIfMissing = true)
public class DevMailService implements MailService {

    private static final Logger log = LoggerFactory.getLogger(DevMailService.class);

    private final AppProperties properties;

    public DevMailService(AppProperties properties) {
        this.properties = properties;
    }

    @Override
    public String mode() {
        return "dev";
    }

    @Override
    public boolean echoTokens() {
        return true;
    }

    @Override
    public void sendVerifyEmail(String to, String username, String link) {
        log.info("""

                ────────────────────────────────────────────────────────────────
                 [邮件未发送 · dev 模式] 邮箱验证
                   收件人 : {} （{}）
                   链接   : {}
                   有效期 : {}
                 上线前请设置 MAIL_MODE=smtp 与 MAIL_HOST/MAIL_USERNAME/MAIL_PASSWORD
                ────────────────────────────────────────────────────────────────""",
                to, username, link, properties.auth().tokenTtl());
    }

    @Override
    public void sendResetPassword(String to, String username, String link) {
        log.info("""

                ────────────────────────────────────────────────────────────────
                 [邮件未发送 · dev 模式] 重置密码
                   收件人 : {} （{}）
                   链接   : {}
                   有效期 : {}
                ────────────────────────────────────────────────────────────────""",
                to, username, link, properties.auth().tokenTtl());
    }
}
