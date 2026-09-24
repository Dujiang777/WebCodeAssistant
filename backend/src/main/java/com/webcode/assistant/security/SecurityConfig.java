package com.webcode.assistant.security;

import com.webcode.assistant.config.AppProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

/**
 * 无状态 JWT 安全配置。
 *
 * <p>要点：
 * <ul>
 *   <li>关闭 CSRF —— 没有 Cookie 会话，浏览器不会自动携带凭证；</li>
 *   <li>只放行 {@code /api/auth/**} 与健康检查，其余一律需要登录；</li>
 *   <li>CORS 白名单来自配置，绝不用 {@code *}；</li>
 *   <li>401 / 403 也返回统一 JSON，前端只需处理一种错误结构。</li>
 * </ul>
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final AppProperties appProperties;

    public SecurityConfig(AppProperties appProperties) {
        this.appProperties = appProperties;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   JwtAuthenticationFilter jwtFilter) throws Exception {
        http
                .csrf(csrf -> csrf.disable())
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        // 放行清单的共同点：这些请求发出时，用户必然还没有可用的 access token。
                        // 漏放行任何一个，用户就会卡在某个环节进不来 —— 而且症状往往是
                        // 「输完密码一直转圈」（前端拿 401 当成令牌过期去刷新，然后死循环）。
                        .requestMatchers(
                                "/api/auth/register",
                                "/api/auth/login",
                                "/api/auth/refresh",
                                "/api/auth/logout",
                                "/api/auth/verify-email",
                                "/api/auth/forgot-password",
                                "/api/auth/reset-password",
                                "/api/health").permitAll()
                        .requestMatchers("/error").permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(handling -> handling
                        .authenticationEntryPoint((request, response, ex) ->
                                AuthErrorWriter.write(response, 401, com.webcode.assistant.common.ErrorCode.UNAUTHORIZED))
                        .accessDeniedHandler((request, response, ex) ->
                                AuthErrorWriter.write(response, 403, com.webcode.assistant.common.ErrorCode.FORBIDDEN)))
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(appProperties.cors().allowedOrigins());
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "Accept", "Last-Event-ID"));
        config.setExposedHeaders(List.of("Content-Type"));
        config.setAllowCredentials(false);
        config.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
