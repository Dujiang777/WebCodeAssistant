package com.webcode.assistant.api;

import com.webcode.assistant.security.AppUserPrincipal;
import com.webcode.assistant.security.AuthService;
import com.webcode.assistant.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 注册 / 登录 / 当前用户。意图上只做参数绑定，业务在 {@link AuthService}。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;
    private final CurrentUser currentUser;

    public AuthController(AuthService authService, CurrentUser currentUser) {
        this.authService = authService;
        this.currentUser = currentUser;
    }

    @PostMapping("/register")
    public ResponseEntity<ApiModels.AuthResponse> register(@Valid @RequestBody ApiModels.RegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(toResponse(authService.register(
                request.username(), request.password())));
    }

    @PostMapping("/login")
    public ApiModels.AuthResponse login(@Valid @RequestBody ApiModels.LoginRequest request) {
        return toResponse(authService.login(request.username(), request.password()));
    }

    @GetMapping("/me")
    public ApiModels.MeResponse me() {
        AppUserPrincipal principal = currentUser.require();
        return new ApiModels.MeResponse(principal.userId(), principal.username());
    }

    private ApiModels.AuthResponse toResponse(AuthService.AuthResult result) {
        return new ApiModels.AuthResponse(result.userId(), result.username(),
                result.token(), result.expiresInSeconds());
    }
}
