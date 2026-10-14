package com.webcode.assistant.constitution;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;

/**
 * 项目说明：这个工作区希望模型怎么干活。
 *
 * <p>宪法是硬规则，仓库里的 {@code .coding-rules.md} 是代码约定。
 * 说明夹在中间，写技术口径、目录习惯、回答详略。只有用户能改，补丁碰不到它。
 */
@Service
public class ProfileService {

    private static final Logger log = LoggerFactory.getLogger(ProfileService.class);

    public static final String PROFILE_PATH = ".wca/PROFILE.md";

    private static final int MAX_CHARS = 16_000;

    private final WorkspacePathResolver pathResolver;

    public ProfileService(WorkspacePathResolver pathResolver) {
        this.pathResolver = pathResolver;
    }

    public ProfileView read(Workspace workspace) {
        Path file = profileFile(workspace);
        if (file == null || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return new ProfileView(false, null, null, 0L);
        }
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            long mtime = Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis();
            boolean blank = text.isBlank();
            return new ProfileView(!blank, blank ? null : PROFILE_PATH, blank ? null : text, mtime);
        } catch (IOException ex) {
            log.warn("读取项目说明失败 workspace={}: {}", workspace.name(), ex.getMessage());
            return new ProfileView(false, null, null, 0L);
        }
    }

    public ProfileView save(Workspace workspace, String content) {
        if (content == null) {
            content = "";
        }
        if (content.length() > MAX_CHARS) {
            throw new ApiException(ErrorCode.BAD_REQUEST,
                    "项目说明过长（" + content.length() + " 字符，上限 " + MAX_CHARS + "）。");
        }
        Path file = profileFile(workspace);
        if (file == null) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "无法定位工作区根目录");
        }
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, content, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            log.warn("保存项目说明失败 workspace={}: {}", workspace.name(), ex.getMessage());
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "项目说明写入磁盘失败：" + ex.getMessage());
        }
        long mtime;
        try {
            mtime = Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis();
        } catch (IOException ex) {
            mtime = System.currentTimeMillis();
        }
        boolean empty = content.isBlank();
        return new ProfileView(!empty, empty ? null : PROFILE_PATH, empty ? null : content, mtime);
    }

    private Path profileFile(Workspace workspace) {
        try {
            Path root = pathResolver.rootOf(workspace.rootPath());
            return root.resolve(".wca").resolve("PROFILE.md");
        } catch (RuntimeException ex) {
            return null;
        }
    }

    public record ProfileView(boolean exists, String path, String content, Long updatedAt) {
        public String updatedAtIso() {
            return updatedAt == null ? null : Instant.ofEpochMilli(updatedAt).toString();
        }
    }
}
