package com.webcode.assistant.api;

import com.webcode.assistant.security.AppUserPrincipal;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.security.RefreshTokenRepository;
import com.webcode.assistant.security.UserAccount;
import com.webcode.assistant.credit.CreditService;
import com.webcode.assistant.mail.MailService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 注册 / 登录 / 令牌续期 / 邮箱验证 / 找回密码 / 会话管理。
 *
 * <p>意图上只做参数绑定与响应组装，业务全在 {@link AuthService}。
 *
 * <p>哪些端点必须匿名可访问（见 {@code SecurityConfig}）：
 * 注册、登录、刷新令牌、忘记密码、重置密码、邮箱验证。
 * 它们的共同点是「此时用户还没有可用的 access token」——
 * 少放行一个，用户就会卡在某个环节进不来。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;
    private final CreditService creditService;
    private final CurrentUser currentUser;
    private final MailService mailService;

    public AuthController(AuthService authService, CreditService creditService,
                          CurrentUser currentUser, MailService mailService) {
        this.authService = authService;
        this.creditService = creditService;
        this.currentUser = currentUser;
        this.mailService = mailService;
    }

    @PostMapping("/register")
    public ResponseEntity<ApiModels.AuthResponse> register(@Valid @RequestBody ApiModels.RegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(toResponse(authService.register(
                request.username(), request.email(), request.password())));
    }

    @PostMapping("/login")
    public ApiModels.AuthResponse login(@Valid @RequestBody ApiModels.LoginRequest request) {
        return toResponse(authService.login(request.username(), request.password()));
    }

    /** 用 refresh token 换一对新令牌。前端在 access 过期时静默调用，用户无感。 */
    @PostMapping("/refresh")
    public ApiModels.AuthResponse refresh(@RequestBody ApiModels.RefreshRequest request) {
        return toResponse(authService.refresh(request.refreshToken()));
    }

    /**
     * 退出登录。
     *
     * <p>不需要登录态（{@code /api/auth/logout} 在放行清单里）：access token 往往已经过期，
     * 用户点「退出」就是要清掉 refresh，此时还要求他先登录一次是荒谬的。
     */
    @PostMapping("/logout")
    public ApiModels.DispatchResponse logout(@RequestBody ApiModels.RefreshRequest request) {
        authService.logout(request.refreshToken());
        return new ApiModels.DispatchResponse(true, null, null);
    }

    @GetMapping("/me")
    public ApiModels.MeResponse me() {
        AppUserPrincipal principal = currentUser.require();
        UserAccount account = authService.require(principal.userId());
        CreditService.Summary credit = creditService.summary(account.id());
        return new ApiModels.MeResponse(account.id(), account.username(), account.email(),
                account.emailVerified(), account.role(), credit.balance(), credit.lowBalance(),
                credit.enforceBalance(), credit.lowBalanceThreshold(), credit.pricingNote(),
                mailService.echoTokens());
    }

    // ------------------------------------------------------------- 邮箱验证

    @PostMapping("/verify-email")
    public ApiModels.DispatchResponse verifyEmail(@Valid @RequestBody ApiModels.VerifyEmailRequest request) {
        authService.verifyEmail(request.token());
        return new ApiModels.DispatchResponse(true, null, null);
    }

    @PostMapping("/resend-verification")
    public ApiModels.DispatchResponse resendVerification() {
        AuthService.Dispatch dispatch = authService.resendVerification(currentUser.require().userId());
        return new ApiModels.DispatchResponse(dispatch.sent(), dispatch.target(), dispatch.devToken());
    }

    // ------------------------------------------------------------- 找回密码

    @PostMapping("/forgot-password")
    public ApiModels.DispatchResponse forgotPassword(@Valid @RequestBody ApiModels.ForgotPasswordRequest request) {
        AuthService.Dispatch dispatch = authService.requestPasswordReset(request.email());
        return new ApiModels.DispatchResponse(dispatch.sent(), dispatch.target(), dispatch.devToken());
    }

    @PostMapping("/reset-password")
    public ApiModels.DispatchResponse resetPassword(@Valid @RequestBody ApiModels.ResetPasswordRequest request) {
        authService.resetPassword(request.token(), request.password());
        return new ApiModels.DispatchResponse(true, null, null);
    }

    @PostMapping("/change-password")
    public ApiModels.AuthResponse changePassword(@Valid @RequestBody ApiModels.ChangePasswordRequest request) {
        return toResponse(authService.changePassword(currentUser.require().userId(),
                request.oldPassword(), request.newPassword()));
    }

    // ------------------------------------------------------------- 登录设备

    @GetMapping("/sessions")
    public List<ApiModels.LoginSessionView> sessions() {
        return authService.sessions(currentUser.require().userId()).stream()
                .map(AuthController::toSession)
                .toList();
    }

    @DeleteMapping("/sessions/{id}")
    public ApiModels.DispatchResponse revokeSession(@PathVariable long id) {
        authService.revokeSession(currentUser.require().userId(), id);
        return new ApiModels.DispatchResponse(true, null, null);
    }

    // ------------------------------------------------------------- 组装

    private static ApiModels.LoginSessionView toSession(RefreshTokenRepository.RefreshTokenRow row) {
        return new ApiModels.LoginSessionView(row.id(), row.device(), row.ip(),
                row.createdAt() == null ? null : row.createdAt().toString(),
                row.expiresAt() == null ? null : row.expiresAt().toString());
    }

    private static ApiModels.AuthResponse toResponse(AuthService.AuthResult result) {
        return new ApiModels.AuthResponse(result.userId(), result.username(), result.email(),
                result.emailVerified(), result.role(), result.accessToken(), result.refreshToken(),
                result.accessTokenExpiresIn(), result.refreshTokenExpiresIn(),
                result.credits(), result.lowBalance(), result.devVerifyToken());
    }
}
