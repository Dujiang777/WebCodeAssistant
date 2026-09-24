package com.webcode.assistant.mail;

import com.webcode.assistant.config.AppProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

import java.util.Properties;

/**
 * SMTP 发送器装配。
 *
 * <p>为什么手写 {@link JavaMailSenderImpl} 而不用 Spring Boot 的
 * {@code MailSenderAutoConfiguration}：那个自动配置读的是 {@code spring.mail.*}，
 * 本项目所有配置都收在 {@code app.*} 下（{@code app.mail.*}），
 * 用自动配置就得把同一份账号密码在 yml 里写两遍 —— 早晚会只改一处。
 *
 * <p>整个 Bean 只在 {@code MAIL_MODE=smtp} 时创建，因此 dev 模式下即使
 * classpath 里有 mail starter，也不会有任何 SMTP 连接被发起。
 */
@Configuration
@ConditionalOnProperty(name = "app.mail.mode", havingValue = "smtp")
public class MailConfig {

    @Bean
    public JavaMailSender javaMailSender(AppProperties properties) {
        AppProperties.Mail mail = properties.mail();
        if (mail.host() == null || mail.host().isBlank()) {
            throw new IllegalStateException(
                    "MAIL_MODE=smtp 但未配置 MAIL_HOST；请补全 MAIL_HOST / MAIL_FROM / MAIL_USERNAME / MAIL_PASSWORD");
        }

        JavaMailSenderImpl sender = new JavaMailSenderImpl();
        sender.setHost(mail.host());
        sender.setPort(mail.port());
        sender.setDefaultEncoding("UTF-8");
        if (mail.username() != null && !mail.username().isBlank()) {
            sender.setUsername(mail.username());
            sender.setPassword(mail.password());
        }

        Properties props = sender.getJavaMailProperties();
        props.put("mail.transport.protocol", "smtp");
        props.put("mail.smtp.auth", String.valueOf(mail.username() != null && !mail.username().isBlank()));
        // 465 是隐式 SSL，587 是明文连接后 STARTTLS；两者不是二选一的美化写法，
        // 用错了会直接卡在握手阶段超时，且报错信息通常很难看出是这个原因。
        props.put("mail.smtp.ssl.enable", String.valueOf(mail.ssl()));
        props.put("mail.smtp.starttls.enable", String.valueOf(!mail.ssl()));
        props.put("mail.smtp.starttls.required", String.valueOf(!mail.ssl()));
        props.put("mail.smtp.connectiontimeout", "10000");
        props.put("mail.smtp.timeout", "10000");
        props.put("mail.smtp.writetimeout", "10000");
        return sender;
    }
}
