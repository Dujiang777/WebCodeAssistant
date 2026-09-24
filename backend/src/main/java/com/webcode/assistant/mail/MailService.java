package com.webcode.assistant.mail;

/**
 * 邮件通道。
 *
 * <p>为什么抽一个接口而不是直接注入 {@code JavaMailSender}：本地开发和自检不可能
 * 依赖一个真实的 SMTP 账号（也没有）。抽出来之后，「发信」这件事有两个实现 ——
 * {@link DevMailService} 只写日志、{@link SmtpMailService} 真发 ——
 * 而 <b>调用方（AuthService）完全不知道区别</b>。上线只需改一个环境变量，
 * 业务代码一行不动。
 *
 * <p>{@link #echoTokens()} 是这条设计唯一的「泄漏」：dev 模式下验证 / 重置令牌会
 * 随接口响应一起返回，否则本地根本拿不到那个链接（邮箱是假的，收不到信）。
 * 线上必须为 false —— {@link SmtpMailService} 硬编码返回 false，不给配置留出错的机会。
 */
public interface MailService {

    /** 通道名，进健康检查与日志，方便确认线上到底跑的是哪种。 */
    String mode();

    /**
     * 是否把令牌回显给接口调用方。
     *
     * <p><b>只有 dev 模式能为 true。</b>这个开关决定了「拿到邮箱地址就能改任何人的密码」，
     * 因此不能做成可配置项 —— 实现类写死。
     */
    boolean echoTokens();

    /** 邮箱验证。 */
    void sendVerifyEmail(String to, String username, String link);

    /** 重置密码。 */
    void sendResetPassword(String to, String username, String link);
}
