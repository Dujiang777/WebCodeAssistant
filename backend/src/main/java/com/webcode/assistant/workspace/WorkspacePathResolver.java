package com.webcode.assistant.workspace;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.regex.Pattern;

/**
 * 工作区路径边界守卫 —— 整个后端唯一允许把「用户输入字符串」变成 {@link Path} 的地方。
 *
 * <p>防护分三层，任一层不通过都抛 {@link ErrorCode#PATH_ESCAPE}：
 * <ol>
 *   <li><b>形式校验</b>：拒绝空字节、绝对路径、Windows 盘符（{@code C:}）、UNC 前缀（{@code \\}）；</li>
 *   <li><b>词法校验</b>：{@code normalize()} 后必须仍以工作区根为前缀，挡掉 {@code ../} 逃逸；</li>
 *   <li><b>物理校验</b>：对已存在（或最近存在的祖先）调用 {@code toRealPath()}，
 *       挡掉「工作区内软链接指向工作区外」这一类绕过。</li>
 * </ol>
 *
 * <p>第 2 层是词法判断，第 3 层是文件系统判断 —— 只有两层都过才算安全，
 * 因为仅靠字符串前缀无法防软链接，仅靠 realpath 又无法处理「目标尚不存在」的写入场景。
 */
@Component
public class WorkspacePathResolver {

    private static final Pattern WINDOWS_DRIVE = Pattern.compile("^[A-Za-z]:");
    private static final int MAX_PATH_LENGTH = 1024;

    /** 把工作区根规范成绝对、归一化的路径。 */
    public Path rootOf(String workspaceRoot) {
        return Path.of(workspaceRoot).toAbsolutePath().normalize();
    }

    /**
     * 把相对路径解析为工作区内的绝对路径。目标<b>允许不存在</b>（用于新建文件）。
     *
     * @param root         工作区根（绝对路径）
     * @param relativePath 前端传入的相对路径，{@code null}/空 表示根目录本身
     */
    public Path resolve(Path root, String relativePath) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        if (relativePath == null || relativePath.isBlank()) {
            return normalizedRoot;
        }
        String raw = relativePath.trim();
        if (raw.length() > MAX_PATH_LENGTH || raw.indexOf('\0') >= 0) {
            throw escape(relativePath);
        }

        String unified = raw.replace('\\', '/');
        if (unified.startsWith("/") || WINDOWS_DRIVE.matcher(unified).find()) {
            throw escape(relativePath);
        }

        Path resolved = normalizedRoot.resolve(unified).normalize();
        if (!resolved.startsWith(normalizedRoot)) {
            throw escape(relativePath);
        }

        assertNoSymlinkEscape(normalizedRoot, resolved, relativePath);
        return resolved;
    }

    /** 把工作区内路径转回相对路径（统一用 {@code /}，便于前端展示与 diff 引用）。 */
    public String relativize(Path root, Path target) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path normalizedTarget = target.toAbsolutePath().normalize();
        if (!normalizedTarget.startsWith(normalizedRoot)) {
            throw escape(target.toString());
        }
        String relative = normalizedRoot.relativize(normalizedTarget).toString();
        return relative.replace('\\', '/');
    }

    /**
     * 物理层校验：对目标（或它最近的已存在祖先）取 realpath，必须落在工作区真实根之内。
     * 这样即使工作区里被人放了指向 {@code /etc} 的软链接，也无法借它读到外面。
     */
    private void assertNoSymlinkEscape(Path normalizedRoot, Path target, String userInput) {
        Path realRoot;
        try {
            realRoot = normalizedRoot.toRealPath();
        } catch (IOException ex) {
            // 根目录还不存在（尚未创建工作区），词法校验已经足够
            return;
        }

        Path cursor = target;
        while (cursor != null && !Files.exists(cursor, LinkOption.NOFOLLOW_LINKS)) {
            cursor = cursor.getParent();
        }
        if (cursor == null) {
            throw escape(userInput);
        }

        try {
            Path realCursor = cursor.toRealPath();
            if (!realCursor.startsWith(realRoot)) {
                throw escape(userInput);
            }
        } catch (IOException ex) {
            throw escape(userInput);
        }
    }

    private ApiException escape(String path) {
        return new ApiException(ErrorCode.PATH_ESCAPE, "路径越界或非法: " + path);
    }
}
