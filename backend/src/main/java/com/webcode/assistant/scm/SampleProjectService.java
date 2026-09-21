package com.webcode.assistant.scm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * 内置演示项目：把 classpath 下的 {@code samples/demo-java} 落盘成一个真实工作区。
 *
 * <p>为什么需要它：验收流程里的「clone 一个小 Java repo」依赖外网，评审环境未必可达。
 * 内置样例让「注册 → 建工作区 → 打开 Java 文件 → 提问 → 出补丁 → 应用」这条链路
 * 在任何环境下都能跑通。
 *
 * <p>文件清单<b>显式列出</b>而不是扫描目录：打成 jar 之后无法可靠地列目录，
 * 显式清单在任何打包形态下行为一致。
 */
@Service
public class SampleProjectService {

    public static final String SAMPLE_NAME = "demo-java";

    private static final Logger log = LoggerFactory.getLogger(SampleProjectService.class);
    private static final String CLASS_PATH_PREFIX = "samples/demo-java/";

    /** 与 src/main/resources/samples/demo-java/ 下的实际文件保持一致。 */
    private static final List<String> FILES = List.of(
            "README.md",
            ".coding-rules.md",
            "pom.xml",
            "src/main/java/com/demo/Application.java",
            "src/main/java/com/demo/User.java",
            "src/main/java/com/demo/UserRepository.java",
            "src/main/java/com/demo/UserService.java",
            "src/main/java/com/demo/UserController.java",
            "src/main/java/com/demo/UserNotFoundException.java",
            "src/test/java/com/demo/UserServiceTest.java");

    public void materialize(Path targetDir) {
        for (String relative : FILES) {
            ClassPathResource resource = new ClassPathResource(CLASS_PATH_PREFIX + relative);
            if (!resource.exists()) {
                throw new ApiException(ErrorCode.INTERNAL_ERROR,
                        "内置样例缺少文件（打包不完整）: " + relative);
            }
            Path destination = targetDir.resolve(relative).normalize();
            if (!destination.startsWith(targetDir)) {
                throw new ApiException(ErrorCode.PATH_ESCAPE, "内置样例路径越界: " + relative);
            }
            try {
                Files.createDirectories(destination.getParent());
                try (InputStream in = resource.getInputStream()) {
                    Files.copy(in, destination, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException ex) {
                throw new ApiException(ErrorCode.INTERNAL_ERROR,
                        "写入内置样例失败: " + relative + " (" + ex.getMessage() + ")", ex);
            }
        }
        log.info("内置样例已写入: {}", targetDir);
    }

    public List<String> fileList() {
        return FILES;
    }
}
