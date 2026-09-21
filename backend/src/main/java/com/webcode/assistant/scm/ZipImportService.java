package com.webcode.assistant.scm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.commons.compress.archivers.zip.ZipFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.stream.Stream;

/**
 * 把上传的 zip 安全解压到工作区目录。
 *
 * <p>三重防护：
 * <ol>
 *   <li><b>Zip Slip</b>：每一条目的路径都先 normalize，必须落在目标目录之内才允许写出；</li>
 *   <li><b>Zip Bomb</b>：限制条目数量、单条目解压体积、总解压体积，并在流式写出时做硬性字节截断，
 *       因为 zip 头里声明的 size 是可以伪造的，不能只信头部；</li>
 *   <li><b>符号链接</b>：跳过 unix 符号链接条目，避免解压出指向系统目录的链接。</li>
 * </ol>
 */
@Service
public class ZipImportService {

    private static final Logger log = LoggerFactory.getLogger(ZipImportService.class);
    private static final String ZIP_ENTRY_SEPARATOR = "/";

    private final AppProperties properties;

    public ZipImportService(AppProperties properties) {
        this.properties = properties;
    }

    /**
     * 解压到 {@code targetDir}。
     *
     * @param archivePath 已落盘的 zip 文件
     * @param targetDir   目标目录（必须已存在且为空）
     * @return 解压后的总字节数
     */
    public long extract(Path archivePath, Path targetDir) {
        Path normalizedTarget = targetDir.toAbsolutePath().normalize();
        long maxTotal = properties.maxWorkspaceBytes();
        long totalWritten = 0;
        int entryCount = 0;

        try (ZipFile zipFile = ZipFile.builder().setPath(archivePath).get()) {
            Enumeration<ZipArchiveEntry> entries = zipFile.getEntries();
            while (entries.hasMoreElements()) {
                ZipArchiveEntry entry = entries.nextElement();

                if (entry.isUnixSymlink()) {
                    log.debug("跳过符号链接条目: {}", entry.getName());
                    continue;
                }
                if (++entryCount > properties.maxArchiveEntries()) {
                    throw new ApiException(ErrorCode.ARCHIVE_INVALID,
                            "压缩包条目数超过上限 " + properties.maxArchiveEntries());
                }

                Path destination = resolveEntry(normalizedTarget, entry.getName());
                if (destination == null) {
                    continue;
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(destination);
                    continue;
                }

                Files.createDirectories(destination.getParent());
                long written = copyBounded(zipFile.getInputStream(entry), destination, maxTotal - totalWritten);
                totalWritten += written;
                if (totalWritten > maxTotal) {
                    throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE,
                            "压缩包解压后体积超过上限 " + (maxTotal / 1024 / 1024) + " MB");
                }
            }
        } catch (IOException ex) {
            cleanup(normalizedTarget);
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "解压失败: " + ex.getMessage(), ex);
        }

        if (totalWritten == 0) {
            cleanup(normalizedTarget);
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "压缩包为空或没有可解压的文件");
        }
        return totalWritten;
    }

    /**
     * 把条目名解析成目标绝对路径。
     * 返回 {@code null} 表示该条目应被跳过（例如 {@code __MACOSX} 垃圾条目）。
     */
    private Path resolveEntry(Path normalizedTarget, String rawName) {
        if (rawName == null || rawName.isBlank()) {
            return null;
        }
        String name = rawName.replace('\\', '/');
        if (name.indexOf('\0') >= 0) {
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "压缩包内存在非法路径");
        }
        // 绝对路径、盘符、UNC 一律拒绝
        if (name.startsWith("/") || name.startsWith("//") || name.matches("^[A-Za-z]:.*")) {
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "压缩包内存在绝对路径条目: " + rawName);
        }
        if (name.contains("__MACOSX/") || name.endsWith(".DS_Store")) {
            return null;
        }

        Path destination = normalizedTarget.resolve(name).normalize();
        // Zip Slip 的核心校验：归一化之后必须仍在目标目录内
        if (!destination.startsWith(normalizedTarget)) {
            throw new ApiException(ErrorCode.ARCHIVE_INVALID, "压缩包内路径越界（Zip Slip）: " + rawName);
        }
        return destination;
    }

    /**
     * 流式拷贝并在超出剩余配额时立即中断 —— 不信任 zip 头里声明的 uncompressedSize。
     */
    private long copyBounded(InputStream in, Path destination, long remainingBudget) throws IOException {
        long written = 0;
        byte[] buffer = new byte[64 * 1024];
        try (OutputStream out = Files.newOutputStream(destination)) {
            int read;
            while ((read = in.read(buffer)) > 0) {
                written += read;
                if (written > remainingBudget) {
                    throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE, "压缩包解压后体积超过工作区上限");
                }
                out.write(buffer, 0, read);
            }
        }
        return written;
    }

    private void cleanup(Path targetDir) {
        try (Stream<Path> walk = Files.walk(targetDir)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                if (!path.equals(targetDir)) {
                    Files.deleteIfExists(path);
                }
            }
        } catch (IOException ex) {
            log.warn("清理解压残留失败: {}", targetDir, ex);
        }
    }
}
