package com.webcode.assistant.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 从当前请求里取「谁、从哪来」，用于登录审计与登录设备列表。
 *
 * <p>{@code X-Forwarded-For} 只在有反向代理时才存在，且它是客户端可伪造的头 ——
 * 所以这里只把它当作「线索」记录（用于让用户认出「这不是我的登录」），
 * <b>绝不作为任何鉴权或限流判据</b>。真正的限流是按 userId 做的。
 */
@Component
public class RequestContext {

    private static final int MAX_DEVICE_LENGTH = 120;

    public String ip() {
        HttpServletRequest request = current();
        if (request == null) {
            return null;
        }
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            // 取第一段（最靠近客户端的那一跳）
            int comma = forwarded.indexOf(',');
            return (comma > 0 ? forwarded.substring(0, comma) : forwarded).trim();
        }
        return request.getRemoteAddr();
    }

    public String userAgent() {
        HttpServletRequest request = current();
        return request == null ? null : request.getHeader("User-Agent");
    }

    /**
     * 设备摘要：完整 UA 有 200 多字符，列表里显示不下。
     * 只留「浏览器 + 系统」这两段信息量最高的部分。
     */
    public String device() {
        String agent = userAgent();
        if (agent == null || agent.isBlank()) {
            return "未知设备";
        }
        String browser = "未知浏览器";
        if (agent.contains("Edg/")) {
            browser = "Edge";
        } else if (agent.contains("Chrome/")) {
            browser = "Chrome";
        } else if (agent.contains("Firefox/")) {
            browser = "Firefox";
        } else if (agent.contains("Safari/")) {
            browser = "Safari";
        } else if (agent.startsWith("node") || agent.contains("undici")) {
            browser = "接口客户端";
        }

        String os = "未知系统";
        if (agent.contains("Windows")) {
            os = "Windows";
        } else if (agent.contains("Mac OS X") || agent.contains("Macintosh")) {
            os = "macOS";
        } else if (agent.contains("Android")) {
            os = "Android";
        } else if (agent.contains("iPhone") || agent.contains("iPad")) {
            os = "iOS";
        } else if (agent.contains("Linux")) {
            os = "Linux";
        }

        String device = browser + " · " + os;
        return device.length() <= MAX_DEVICE_LENGTH ? device : device.substring(0, MAX_DEVICE_LENGTH);
    }

    private HttpServletRequest current() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            return attributes.getRequest();
        }
        return null;
    }
}
