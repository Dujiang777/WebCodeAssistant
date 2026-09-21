package com.webcode.assistant.config;

import com.webcode.assistant.llm.LlmProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 启动自检：确保工作区根目录存在、可写，并在未配置模型时给出清晰告警。
 */
@Configuration
public class StartupConfig {

    private static final Logger log = LoggerFactory.getLogger(StartupConfig.class);

    private final AppProperties appProperties;
    private final LlmProperties llmProperties;

    public StartupConfig(AppProperties appProperties, LlmProperties llmProperties) {
        this.appProperties = appProperties;
        this.llmProperties = llmProperties;
    }

    @Bean
    public ApplicationRunner workspaceRootInitializer() {
        return args -> {
            Path root = Path.of(appProperties.workspaceRoot()).toAbsolutePath().normalize();
            Files.createDirectories(root);
            if (!Files.isWritable(root)) {
                throw new IllegalStateException("工作区根目录不可写: " + root);
            }
            log.info("工作区根目录: {}（单库上限 {} MB）", root, appProperties.maxWorkspaceBytes() / 1024 / 1024);
        };
    }

    @EventListener(ApplicationReadyEvent.class)
    public void reportModelStatus() {
        if (llmProperties.isConfigured()) {
            log.info("模型已配置: {} @ {}", llmProperties.model(), llmProperties.baseUrl());
        } else {
            log.warn("未配置模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），对话接口将返回 LLM_NOT_CONFIGURED；"
                    + "文件浏览、编辑、补丁应用不受影响。");
        }
    }
}
