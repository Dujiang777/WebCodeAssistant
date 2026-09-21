package com.webcode.assistant.scm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Git 远程地址校验。
 *
 * <p>只允许真正意义上的「远程」协议。特别禁止：
 * <ul>
 *   <li>{@code file://} 与裸本地路径 —— 否则用户能让服务器去 clone 服务器自己的目录
 *       （例如 {@code /etc}、{@code ~/.ssh}），这是一个典型的 SSRF/本地文件泄露入口；</li>
 *   <li>{@code ext::} 与 {@code -} 前缀 —— Git 的 remote helper 可以借它执行本地命令。</li>
 * </ul>
 */
public final class GitUrlValidator {

    private static final Set<String> ALLOWED_SCHEMES = Set.of("http", "https", "git", "ssh");

    /** scp 风格：git@github.com:owner/repo.git */
    private static final Pattern SCP_STYLE = Pattern.compile("^[\\w.-]+@[\\w.-]+:[\\w./~-]+$");

    private GitUrlValidator() {
    }

    public static String validateAndNormalize(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "Git 地址不能为空");
        }
        String url = rawUrl.trim();
        if (url.length() > 2048) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "Git 地址过长");
        }
        if (url.startsWith("-") || url.contains("\n") || url.contains("\r") || url.contains("\0")) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "Git 地址包含非法字符");
        }

        if (SCP_STYLE.matcher(url).matches()) {
            return url;
        }

        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException ex) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "Git 地址格式不合法");
        }

        String scheme = uri.getScheme();
        if (scheme == null) {
            throw new ApiException(ErrorCode.BAD_REQUEST,
                    "Git 地址必须带协议前缀（https:// 或 ssh://），不接受服务器本地路径");
        }
        if (!ALLOWED_SCHEMES.contains(scheme.toLowerCase(Locale.ROOT))) {
            throw new ApiException(ErrorCode.BAD_REQUEST,
                    "不支持的 Git 协议: " + scheme + "（仅支持 http/https/git/ssh）");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "Git 地址缺少主机名");
        }
        return url;
    }

    /** 由 URL 推断一个安全的工作区名字。 */
    public static String suggestName(String url) {
        String cleaned = url;
        int hash = cleaned.indexOf('#');
        if (hash >= 0) {
            cleaned = cleaned.substring(0, hash);
        }
        while (cleaned.endsWith("/")) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        int colon = cleaned.lastIndexOf(':');
        int slash = cleaned.lastIndexOf('/');
        int cut = Math.max(colon, slash);
        String name = cut >= 0 ? cleaned.substring(cut + 1) : cleaned;
        if (name.endsWith(".git")) {
            name = name.substring(0, name.length() - 4);
        }
        name = name.replaceAll("[^A-Za-z0-9._-]", "-");
        if (name.isBlank()) {
            name = "workspace";
        }
        return name.length() > 60 ? name.substring(0, 60) : name;
    }
}
