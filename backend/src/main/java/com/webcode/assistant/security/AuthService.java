package com.webcode.assistant.security;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.common.Tokens;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.mail.MailService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 注册 / 登录 / 邮箱验证 / 找回密码 / 改密 / 会话管理。
 *
 * <p>相对第一期的三点升级，每一点都对应一个真实的线上风险：
 * <ol>
 *   <li><b>邮箱 + 验证</b>：没有验证的邮箱等于没有邮箱 —— 找回密码、通知、风控全靠它；</li>
 *   <li><b>失败锁定</b>：没有它，密码可以被无限次撞。这条是所有账号系统里最容易被漏掉的一条；</li>
 *   <li><b>双令牌</b>：access 短、refresh 长且可撤销。改密 / 退出 / 异常登录都能立刻踢下线。</li>
 * </ol>
 *
 * <p>另外两处刻意的细节：<b>不区分「用户不存在」与「密码错误」</b>（防用户名枚举），
 * 以及<b>用户不存在时也走一次密码哈希校验</b>（否则响应时间会暴露账号是否存在，
 * 这是最容易被忽略的旁路）。
 */
@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[A-Za-z0-9_.-]{3,64}$");
    private static final Pattern EMAIL_PATTERN =
            Pattern.compile("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$");
    private static final int MIN_PASSWORD_LENGTH = 8;
    private static final int MAX_PASSWORD_LENGTH = 128;

    /**
     * 用户不存在时拿来做「陪跑」哈希的假密码。
     *
     * <p>它的唯一作用是让两条失败路径耗时相当。没有它的话，
     * 「用户名不存在」会比「密码错误」快整整一个 bcrypt 周期（约 100ms），
     * 攻击者据此就能批量枚举出哪些用户名是真实存在的。
     */
    private static final String DUMMY_HASH =
            "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

    private final UserRepository userRepository;
    private final EmailTokenRepository emailTokenRepository;
    private final LoginAuditRepository loginAuditRepository;
    /**
     * 失败计数与异常登录审计走它自己的事务。
     *
     * <p>不能直接调 {@code userRepository.registerFailedAttempt} —— 那个写操作在
     * {@code login} 的事务里，而登录失败会抛异常把它一起回滚掉，
     * 结果是「失败次数永远归零、锁定策略静默失效」。详见 {@link LoginAttemptRecorder}。
     */
    private final LoginAttemptRecorder loginAttemptRecorder;
    private final PasswordEncoder passwordEncoder;
    private final TokenService tokenService;
    private final CreditService creditService;
    private final MailService mailService;
    private final RequestContext requestContext;
    private final AppProperties properties;

    public AuthService(UserRepository userRepository,
                       EmailTokenRepository emailTokenRepository,
                       LoginAuditRepository loginAuditRepository,
                       LoginAttemptRecorder loginAttemptRecorder,
                       PasswordEncoder passwordEncoder,
                       TokenService tokenService,
                       CreditService creditService,
                       MailService mailService,
                       RequestContext requestContext,
                       AppProperties properties) {
        this.userRepository = userRepository;
        this.emailTokenRepository = emailTokenRepository;
        this.loginAuditRepository = loginAuditRepository;
        this.loginAttemptRecorder = loginAttemptRecorder;
        this.passwordEncoder = passwordEncoder;
        this.tokenService = tokenService;
        this.creditService = creditService;
        this.mailService = mailService;
        this.requestContext = requestContext;
        this.properties = properties;
    }

    /** 注册 / 登录返回体。{@code devVerifyToken} 只在 dev 邮件模式下非空。 */
    public record AuthResult(long userId, String username, String email, boolean emailVerified,
                             String role, String accessToken, String refreshToken,
                             long accessTokenExpiresIn, long refreshTokenExpiresIn,
                             long credits, boolean lowBalance, String devVerifyToken) {
    }

    /** 发信结果。dev 模式下带上令牌，供本地与自检脚本走通全流程。 */
    public record Dispatch(boolean sent, String target, String devToken) {
    }

    // ---------------------------------------------------------------- 注册

    @Transactional
    public AuthResult register(String rawUsername, String rawEmail, String rawPassword) {
        String username = normalizeUsername(rawUsername);
        String email = normalizeEmail(rawEmail);
        validatePassword(rawPassword);

        if (userRepository.existsByUsername(username)) {
            throw new ApiException(ErrorCode.CONFLICT, "用户名已被占用");
        }
        if (userRepository.existsByEmail(email)) {
            throw new ApiException(ErrorCode.EMAIL_TAKEN, "该邮箱已被注册");
        }

        long userId;
        try {
            userId = userRepository.insert(username, email,
                    passwordEncoder.encode(rawPassword), UserAccount.ROLE_USER);
        } catch (DuplicateKeyException ex) {
            // 并发注册同名/同邮箱时唯一索引兜底
            throw new ApiException(ErrorCode.CONFLICT, "用户名或邮箱已被占用");
        }

        // 送积分与发验证邮件都在同一个事务里：注册成功但账户没建好，是最难排查的一类状态。
        creditService.grantSignupBonus(userId);
        // 引导提升可能刚刚把 role 改成 ADMIN，所以返回体必须重读一次 ——
        // 否则「注册完就显示自己是普通用户，刷新一下才发现是管理员」，
        // 前端据此渲染的菜单会先错一版。
        boolean promoted = promoteIfBootstrapAdmin(username);
        String devToken = sendVerification(userId, email, username);

        TokenService.IssuedTokens tokens = tokenService.issue(userId, username,
                requestContext.device(), requestContext.ip());
        long credits = creditService.summary(userId).balance();
        String role = promoted
                ? userRepository.findById(userId).map(UserAccount::role).orElse(UserAccount.ROLE_USER)
                : UserAccount.ROLE_USER;
        return new AuthResult(userId, username, email, false, role,
                tokens.accessToken(), tokens.refreshToken(),
                tokens.accessExpiresInSeconds(), tokens.refreshExpiresInSeconds(),
                credits, credits < properties.credit().lowBalanceThreshold(), devToken);
    }

    // ---------------------------------------------------------------- 登录

    @Transactional
    public AuthResult login(String identifier, String rawPassword) {
        String id = identifier == null ? "" : identifier.trim();
        String ip = requestContext.ip();
        String userAgent = requestContext.userAgent();

        Optional<UserAccount> found = userRepository.findByUsernameOrEmail(id);
        if (found.isEmpty()) {
            // 陪跑一次哈希，抹平耗时差异；再记审计，保留撞库线索
            passwordEncoder.matches(rawPassword == null ? "" : rawPassword, DUMMY_HASH);
            loginAttemptRecorder.recordAnomaly(null, id, LoginAuditRepository.REASON_UNKNOWN_USER, ip, userAgent);
            throw new ApiException(ErrorCode.UNAUTHORIZED, "用户名或密码错误");
        }

        UserAccount account = found.get();
        if (!account.active()) {
            loginAttemptRecorder.recordAnomaly(account.id(), account.username(),
                    LoginAuditRepository.REASON_DISABLED, ip, userAgent);
            throw new ApiException(ErrorCode.ACCOUNT_DISABLED, "账号已被停用，请联系管理员");
        }
        if (account.lockedNow()) {
            loginAttemptRecorder.recordAnomaly(account.id(), account.username(),
                    LoginAuditRepository.REASON_LOCKED, ip, userAgent);
            long minutes = Math.max(1, Duration.between(Instant.now(), account.lockedUntil()).toMinutes() + 1);
            throw new ApiException(ErrorCode.ACCOUNT_LOCKED,
                    "连续登录失败次数过多，账号已锁定，请在 " + minutes + " 分钟后重试");
        }

        if (!passwordEncoder.matches(rawPassword == null ? "" : rawPassword, account.passwordHash())) {
            int max = properties.auth().maxFailedAttempts();
            int attempts = loginAttemptRecorder.recordBadPassword(account.id(), account.username(), max,
                    properties.auth().lockDuration(), ip, userAgent);

            int remaining = max - attempts;
            if (remaining > 0) {
                throw new ApiException(ErrorCode.UNAUTHORIZED,
                        "用户名或密码错误（还可尝试 " + remaining + " 次）");
            }
            throw new ApiException(ErrorCode.ACCOUNT_LOCKED,
                    "连续登录失败次数过多，账号已锁定 "
                            + properties.auth().lockDuration().toMinutes() + " 分钟");
        }

        userRepository.markLoginSuccess(account.id());
        auditSuccess(account.id(), account.username());
        if (promoteIfBootstrapAdmin(account.username())) {
            // 刚被引导提升为管理员：重读一次，否则返回体里的 role 还是旧的
            account = require(account.id());
        }

        TokenService.IssuedTokens tokens = tokenService.issue(account.id(), account.username(),
                requestContext.device(), requestContext.ip());
        long credits = creditService.summary(account.id()).balance();
        return new AuthResult(account.id(), account.username(), account.email(), account.emailVerified(),
                account.role(), tokens.accessToken(), tokens.refreshToken(),
                tokens.accessExpiresInSeconds(), tokens.refreshExpiresInSeconds(),
                credits, credits < properties.credit().lowBalanceThreshold(), null);
    }

    // ---------------------------------------------------------------- 令牌

    public AuthResult refresh(String rawRefresh) {
        TokenService.Rotated rotated = tokenService.rotate(rawRefresh,
                requestContext.device(), requestContext.ip());
        UserAccount account = userRepository.findById(rotated.userId())
                .orElseThrow(() -> new ApiException(ErrorCode.TOKEN_INVALID, "账号不存在，请重新登录"));
        long credits = creditService.summary(account.id()).balance();
        return new AuthResult(account.id(), account.username(), account.email(), account.emailVerified(),
                account.role(), rotated.tokens().accessToken(), rotated.tokens().refreshToken(),
                rotated.tokens().accessExpiresInSeconds(), rotated.tokens().refreshExpiresInSeconds(),
                credits, credits < properties.credit().lowBalanceThreshold(), null);
    }

    public void logout(String rawRefresh) {
        tokenService.revoke(rawRefresh);
    }

    public List<RefreshTokenRepository.RefreshTokenRow> sessions(long userId) {
        return tokenService.activeSessions(userId);
    }

    /** 踢掉一台设备（只能踢自己的）。 */
    public int revokeSession(long userId, long tokenId) {
        return tokenService.revokeOne(userId, tokenId);
    }

    // ---------------------------------------------------------------- 邮箱验证

    @Transactional
    public Dispatch resendVerification(long userId) {
        UserAccount account = require(userId);
        if (account.email() == null || account.email().isBlank()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "该账号未绑定邮箱");
        }
        if (account.emailVerified()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "邮箱已经验证过了");
        }
        checkCooldown(userId, EmailTokenRepository.PURPOSE_VERIFY_EMAIL);

        String devToken = sendVerification(userId, account.email(), account.username());
        return new Dispatch(true, mask(account.email()), devToken);
    }

    @Transactional
    public boolean verifyEmail(String rawToken) {
        long userId = emailTokenRepository
                .consume(Tokens.hash(rawToken), EmailTokenRepository.PURPOSE_VERIFY_EMAIL)
                .orElseThrow(() -> new ApiException(ErrorCode.TOKEN_INVALID,
                        "验证链接无效或已过期，请重新发送验证邮件"));
        userRepository.markEmailVerified(userId);
        log.info("邮箱验证成功 userId={}", userId);
        return true;
    }

    // ---------------------------------------------------------------- 找回密码

    /**
     * 请求重置密码。
     *
     * <p><b>无论邮箱是否存在都返回成功</b>：如果这里报「该邮箱未注册」，
     * 这个接口就变成了一个免费的账号枚举器。代价是用户输错邮箱时收不到信、
     * 也不知道错在哪 —— 这个取舍是行业标准，页面上会写清楚「若该邮箱已注册，我们会发送邮件」。
     */
    @Transactional
    public Dispatch requestPasswordReset(String rawEmail) {
        String email = rawEmail == null ? "" : rawEmail.trim().toLowerCase();
        if (!EMAIL_PATTERN.matcher(email).matches()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "请输入有效的邮箱地址");
        }
        Optional<UserAccount> found = userRepository.findByEmail(email);
        if (found.isEmpty()) {
            return new Dispatch(true, mask(email), null);
        }
        UserAccount account = found.get();
        try {
            checkCooldown(account.id(), EmailTokenRepository.PURPOSE_RESET_PASSWORD);
        } catch (ApiException cooldown) {
            // 冷却期内不重发，但对外依然是「已发送」——
            // 否则「有没有到冷却」又成了一条可观测的旁路信息。
            return new Dispatch(true, mask(email), null);
        }
        String devToken = issueToken(account.id(), account.email(), account.username(),
                EmailTokenRepository.PURPOSE_RESET_PASSWORD);
        return new Dispatch(true, mask(email), devToken);
    }

    @Transactional
    public void resetPassword(String rawToken, String newPassword) {
        validatePassword(newPassword);
        long userId = emailTokenRepository
                .consume(Tokens.hash(rawToken), EmailTokenRepository.PURPOSE_RESET_PASSWORD)
                .orElseThrow(() -> new ApiException(ErrorCode.TOKEN_INVALID,
                        "重置链接无效或已过期，请重新获取"));
        userRepository.updatePassword(userId, passwordEncoder.encode(newPassword));
        // 改密码 = 之前所有登录态一律作废。这正是 refresh 落库的意义：
        // 「我密码泄露了，改完就没事了」必须成立。
        int revoked = tokenService.revokeAll(userId);
        log.info("密码已重置 userId={} 同时吊销会话数={}", userId, revoked);
    }

    /**
     * 登录状态下改密码。
     *
     * <p>改完把其他设备全部踢掉，但给<b>当前设备</b>换一对新令牌 ——
     * 否则用户在自己浏览器上改完密码立刻被登出，会以为改失败了。
     */
    @Transactional
    public AuthResult changePassword(long userId, String oldPassword, String newPassword) {
        UserAccount account = require(userId);
        if (!passwordEncoder.matches(oldPassword == null ? "" : oldPassword, account.passwordHash())) {
            throw new ApiException(ErrorCode.UNAUTHORIZED, "原密码不正确");
        }
        if (oldPassword != null && oldPassword.equals(newPassword)) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "新密码不能与原密码相同");
        }
        validatePassword(newPassword);

        userRepository.updatePassword(userId, passwordEncoder.encode(newPassword));
        int revoked = tokenService.revokeAll(userId);
        TokenService.IssuedTokens tokens = tokenService.issue(userId, account.username(),
                requestContext.device(), requestContext.ip());
        log.info("修改密码 userId={} 其他会话已吊销 {}", userId, revoked);

        long credits = creditService.summary(userId).balance();
        return new AuthResult(userId, account.username(), account.email(), account.emailVerified(),
                account.role(), tokens.accessToken(), tokens.refreshToken(),
                tokens.accessExpiresInSeconds(), tokens.refreshExpiresInSeconds(),
                credits, credits < properties.credit().lowBalanceThreshold(), null);
    }

    // ---------------------------------------------------------------- 查询 / 权限

    public UserAccount require(long userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "账号不存在"));
    }

    /** 按用户名查账号（管理端用）。找不到时抛 404 而不是 401 —— 这是查询不是鉴权。 */
    public UserAccount requireByName(String username) {
        return userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "用户不存在：" + username));
    }

    /** 管理端鉴权。注意是「从库里读角色」而不是「读令牌里的角色」——改权限要立刻生效。 */
    public UserAccount requireAdmin(long userId) {
        UserAccount account = require(userId);
        if (!account.admin()) {
            throw new ApiException(ErrorCode.FORBIDDEN, "需要管理员权限");
        }
        return account;
    }

    public List<LoginAuditRow> recentLoginFailures(String username, int minutes) {
        long count = loginAuditRepository.recentFailures(username, minutes);
        return List.of(new LoginAuditRow(username, count, minutes));
    }

    public record LoginAuditRow(String username, long failures, int windowMinutes) {
    }

    // ---------------------------------------------------------------- 内部

    private String sendVerification(long userId, String email, String username) {
        return issueToken(userId, email, username, EmailTokenRepository.PURPOSE_VERIFY_EMAIL);
    }

    /**
     * 管理员引导：用户名在 {@code ADMIN_USERNAMES} 里且当前不是 ADMIN 时，单向提升。
     *
     * <p>三个刻意的限制，缺一个都会变成后门：
     * <ul>
     *   <li><b>默认名单为空</b>（见 application.yml），不配就完全不存在这条路径；</li>
     *   <li>只<b>提升</b>不降级 —— 「移出名单」不应该顺手把人降权，那是管理端的职责；</li>
     *   <li>已经拿到 access token 的旧会话不受影响，但权限判定每次都读库，
     *       所以提升后立刻生效，不需要重新登录。</li>
     * </ul>
     *
     * @return 本次是否发生了提升
     */
    private boolean promoteIfBootstrapAdmin(String username) {
        List<String> bootstrap = properties.auth().adminUsernames();
        if (bootstrap == null || bootstrap.isEmpty() || username == null) {
            return false;
        }
        boolean listed = bootstrap.stream().anyMatch(name -> name != null && name.equalsIgnoreCase(username));
        if (!listed) {
            return false;
        }
        Optional<UserAccount> found = userRepository.findByUsername(username);
        if (found.isEmpty() || found.get().admin()) {
            return false;
        }
        userRepository.updateRoleAndStatus(found.get().id(), UserAccount.ROLE_ADMIN, found.get().status());
        log.warn("按 ADMIN_USERNAMES 引导配置把 {} 提升为管理员；正式环境建好管理员后请清空该配置", username);
        return true;
    }

    /** 签发令牌 + 发信，返回 dev 模式下可回显的原始令牌。 */
    private String issueToken(long userId, String email, String username, String purpose) {
        String raw = Tokens.newRaw();
        emailTokenRepository.issue(userId, Tokens.hash(raw), purpose,
                Instant.now().plus(properties.auth().tokenTtl()));

        String path = EmailTokenRepository.PURPOSE_VERIFY_EMAIL.equals(purpose)
                ? "/#/verify-email?token="
                : "/#/reset-password?token=";
        String link = trimTrailingSlash(properties.auth().frontendBaseUrl()) + path + raw;

        if (EmailTokenRepository.PURPOSE_VERIFY_EMAIL.equals(purpose)) {
            mailService.sendVerifyEmail(email, username, link);
        } else {
            mailService.sendResetPassword(email, username, link);
        }
        return mailService.echoTokens() ? raw : null;
    }

    private void checkCooldown(long userId, String purpose) {
        Duration cooldown = properties.auth().resendCooldown();
        if (cooldown == null || cooldown.isZero() || cooldown.isNegative()) {
            return;
        }
        emailTokenRepository.lastIssuedAt(userId, purpose).ifPresent(lastIssued -> {
            Instant readyAt = lastIssued.plus(cooldown);
            if (Instant.now().isBefore(readyAt)) {
                long seconds = Math.max(1, Duration.between(Instant.now(), readyAt).toSeconds());
                throw new ApiException(ErrorCode.RATE_LIMITED, "发送太频繁，请 " + seconds + " 秒后再试");
            }
        });
    }

    /**
     * 成功登录的审计。
     *
     * <p>这一条刻意<b>跟着主事务走</b>（不是 REQUIRES_NEW）：它记录的是
     * 「这次登录成立了」，与后面的令牌签发是同一件事 —— 签发失败时这条也不该留下。
     * 失败路径正相反，走 {@link LoginAttemptRecorder} 的独立事务。
     * 审计写入失败不能影响登录本身，所以整段吞异常只记日志。
     */
    private void auditSuccess(long userId, String username) {
        try {
            loginAuditRepository.record(userId, username, true, null,
                    requestContext.ip(), requestContext.userAgent());
        } catch (RuntimeException ex) {
            log.warn("写登录审计失败 username={}: {}", username, ex.getMessage());
        }
    }

    private String normalizeUsername(String rawUsername) {
        String username = rawUsername == null ? "" : rawUsername.trim();
        if (!USERNAME_PATTERN.matcher(username).matches()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "用户名需为 3-64 位的字母、数字、下划线、点或短横线");
        }
        return username;
    }

    /**
     * 邮箱统一小写入库。
     *
     * <p>不这么做的话 {@code a@x.com} 与 {@code A@x.com} 会变成两个账号，
     * 而用户自己完全意识不到 —— 这是「同一个邮箱注册了两次」的根源。
     */
    private String normalizeEmail(String rawEmail) {
        String email = rawEmail == null ? "" : rawEmail.trim().toLowerCase();
        if (email.isEmpty()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "邮箱不能为空");
        }
        if (email.length() > 160) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "邮箱长度不能超过 160");
        }
        if (!EMAIL_PATTERN.matcher(email).matches()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "请输入有效的邮箱地址");
        }
        return email;
    }

    /**
     * 密码强度：长度 8-128，且至少包含字母与数字。
     *
     * <p>要求「字母 + 数字」而不是「大小写 + 符号」：后者会把用户逼去用
     * {@code Password1!} 这类实际上更弱的密码。8 位起 + 两类字符是一个
     * 强度与通过率都比较平衡的档位（NIST SP 800-63B 也不再推荐强制符号）。
     */
    private void validatePassword(String rawPassword) {
        int length = rawPassword == null ? 0 : rawPassword.length();
        if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "密码长度需在 " + MIN_PASSWORD_LENGTH + "-" + MAX_PASSWORD_LENGTH + " 之间");
        }
        boolean hasLetter = rawPassword.chars().anyMatch(Character::isLetter);
        boolean hasDigit = rawPassword.chars().anyMatch(Character::isDigit);
        if (!hasLetter || !hasDigit) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "密码需同时包含字母和数字");
        }
    }

    private static String mask(String email) {
        int at = email.indexOf('@');
        if (at <= 0) {
            return "***";
        }
        String name = email.substring(0, at);
        String domain = email.substring(at);
        String head = name.length() <= 2 ? name.substring(0, 1) : name.substring(0, 2);
        return head + "***" + domain;
    }

    private static String trimTrailingSlash(String value) {
        return value != null && value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
