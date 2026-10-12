package com.webcode.assistant.scm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceService;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.Status;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.errors.RepositoryNotFoundException;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 工作区本地 Git：看分支和脏文件，按人点的「提交」落一条 commit。
 *
 * <p>不是给模型的工具。没有 push、没有 remote、没有任意命令 ——
 * Agent 仍然不能写盘，更不能改历史。人在状态栏点一下，才动 {@code .git}。
 */
@Service
public class GitWorkspaceService {

    private static final Logger log = LoggerFactory.getLogger(GitWorkspaceService.class);

    private static final int FILE_LIMIT = 20;

    private static final String DEFAULT_IGNORE = """
            target/
            build/
            node_modules/
            .idea/
            *.iml
            .DS_Store
            """;

    private final WorkspaceService workspaceService;

    public GitWorkspaceService(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }

    public GitStatusView status(Workspace workspace) {
        Path root = workspaceService.rootOf(workspace);
        if (!isRepo(root)) {
            return GitStatusView.absent();
        }
        try (Git git = Git.open(root.toFile())) {
            String branch = git.getRepository().getBranch();
            Status status = git.status().call();
            List<String> files = changedFiles(status);
            String last = lastMessage(git);
            return new GitStatusView(true, branch == null || branch.isBlank() ? "HEAD" : branch,
                    files.size(), files.stream().limit(FILE_LIMIT).toList(), last);
        } catch (IOException | GitAPIException ex) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "读 Git 状态失败：" + shortMessage(ex), ex);
        }
    }

    public GitStatusView init(Workspace workspace) {
        Path root = workspaceService.rootOf(workspace);
        if (isRepo(root)) {
            return status(workspace);
        }
        try (Git git = Git.init().setDirectory(root.toFile()).call()) {
            writeIgnore(root);
            log.info("工作区 {} 已 git init", workspace.id());
        } catch (GitAPIException | IOException ex) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "初始化仓库失败：" + shortMessage(ex), ex);
        }
        return status(workspace);
    }

    public GitCommitView commit(Workspace workspace, String rawMessage, String username) {
        Path root = workspaceService.rootOf(workspace);
        if (!isRepo(root)) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "还不是 Git 仓库，先初始化");
        }
        String message = rawMessage == null ? "" : rawMessage.strip();
        if (message.isBlank()) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "提交说明不能空");
        }
        if (message.length() > 2000) {
            message = message.substring(0, 2000);
        }
        String author = (username == null || username.isBlank()) ? "wca" : username.strip();
        PersonIdent ident = new PersonIdent(author, author + "@users.noreply.wca.local");
        try (Git git = Git.open(root.toFile())) {
            git.add().addFilepattern(".").setUpdate(false).call();
            git.add().setUpdate(true).addFilepattern(".").call();
            Status status = git.status().call();
            List<String> files = changedFiles(status);
            if (files.isEmpty()) {
                throw new ApiException(ErrorCode.BAD_REQUEST, "没有可提交的改动");
            }
            RevCommit commit = git.commit()
                    .setAuthor(ident)
                    .setCommitter(ident)
                    .setMessage(message)
                    .call();
            String sha = commit.abbreviate(7).name();
            log.info("工作区 {} 提交 {}（{} 个文件）", workspace.id(), sha, files.size());
            return new GitCommitView(sha, message, files.size());
        } catch (ApiException ex) {
            throw ex;
        } catch (IOException | GitAPIException ex) {
            throw new ApiException(ErrorCode.BAD_REQUEST, "提交失败：" + shortMessage(ex), ex);
        }
    }

    private static boolean isRepo(Path root) {
        try (Git git = Git.open(root.toFile())) {
            return git.getRepository() != null;
        } catch (RepositoryNotFoundException ex) {
            return false;
        } catch (IOException ex) {
            return false;
        }
    }

    private static List<String> changedFiles(Status status) {
        Set<String> files = new LinkedHashSet<>();
        files.addAll(status.getModified());
        files.addAll(status.getChanged());
        files.addAll(status.getAdded());
        files.addAll(status.getRemoved());
        files.addAll(status.getMissing());
        files.addAll(status.getUntracked());
        return new ArrayList<>(files);
    }

    private static String lastMessage(Git git) {
        try {
            var log = git.log().setMaxCount(1).call();
            for (RevCommit commit : log) {
                String shortMsg = commit.getShortMessage();
                return shortMsg == null || shortMsg.isBlank() ? null : shortMsg;
            }
        } catch (GitAPIException | RuntimeException ignored) {
            // 空仓库没有 commit
        }
        return null;
    }

    private static void writeIgnore(Path root) throws IOException {
        Path ignore = root.resolve(".gitignore");
        if (Files.exists(ignore)) {
            return;
        }
        Files.writeString(ignore, DEFAULT_IGNORE, StandardCharsets.UTF_8);
    }

    private static String shortMessage(Throwable throwable) {
        String message = throwable.getMessage();
        return message == null || message.isBlank() ? throwable.getClass().getSimpleName() : message;
    }

    public record GitStatusView(boolean repo, String branch, int dirty, List<String> files, String lastCommit) {
        static GitStatusView absent() {
            return new GitStatusView(false, null, 0, List.of(), null);
        }
    }

    public record GitCommitView(String sha, String message, int files) {
    }
}
