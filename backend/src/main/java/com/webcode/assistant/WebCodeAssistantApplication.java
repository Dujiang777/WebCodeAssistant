package com.webcode.assistant;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Web Code Assistant —— 一个「人在环上」的网页版编码助手后端。
 *
 * <p>分层约定：
 * <ul>
 *   <li>{@code api} 控制器，只做参数绑定与权限入口；</li>
 *   <li>{@code agent} Agent 循环、工具集、SSE 事件总线、补丁生命周期；</li>
 *   <li>{@code context} 上下文组装（当前文件 / 选区 / 项目摘要 / 历史）；</li>
 *   <li>{@code workspace} 根目录边界、路径校验、统一 diff 应用；</li>
 *   <li>{@code scm} Git 克隆与归档导入；</li>
 *   <li>{@code llm} 模型配置、用量与限流守卫；</li>
 *   <li>{@code security} 登录态与工作区归属校验。</li>
 * </ul>
 *
 * <p>排除 {@code UserDetailsServiceAutoConfiguration}：本服务只用 JWT 无状态鉴权，
 * 账号存在自己的 {@code users} 表里。不排除的话 Spring Boot 会额外造一个内存用户，
 * 并在每次启动时打印一串「generated security password」——那串密码没有任何入口能用上，
 * 只会让人误以为存在一个能登录的默认账号。
 */
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@ConfigurationPropertiesScan
public class WebCodeAssistantApplication {

    public static void main(String[] args) {
        SpringApplication.run(WebCodeAssistantApplication.class, args);
    }
}
