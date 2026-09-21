package com.webcode.assistant.llm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 模型客户端配置。
 *
 * <p><b>为什么不用 {@code langchain4j-spring-boot-starter}：</b>该 starter 目前最新只到
 * {@code 1.0.0-beta5}，落后于核心库 1.0.0，混用会出现 API 不一致。这里直接用核心库 +
 * 显式 {@code @Bean}，好处是：模型参数、超时、日志开关全在一处可见，也便于将来按用户覆盖配置。
 *
 * <p>接口完全按 OpenAI 兼容协议对接，因此 DeepSeek、硅基流动、各类中转、官方 OpenAI
 * 都只是 {@code baseUrl / apiKey / model} 三个值不同，代码无需改动。
 *
 * <p>未配置模型时不创建 Bean：后端依然能启动，文件浏览与编辑照常可用，
 * 只有对话接口会返回 {@link ErrorCode#LLM_NOT_CONFIGURED}，而不是启动即失败。
 */
@Configuration
public class ChatModelConfig {

    private static final Logger log = LoggerFactory.getLogger(ChatModelConfig.class);

    @Bean
    public OpenAiStreamingChatModel openAiStreamingChatModel(LlmProperties properties) {
        if (!properties.isConfigured()) {
            log.warn("LLM 未配置，跳过模型 Bean 创建");
            return null;
        }
        log.info("初始化模型: {} @ {}（temperature={}, maxTokens={}, timeout={}）",
                properties.model(), properties.baseUrl(), properties.temperature(),
                properties.maxTokens(), properties.timeout());

        return OpenAiStreamingChatModel.builder()
                .baseUrl(properties.baseUrl())
                .apiKey(properties.apiKey())
                .modelName(properties.model())
                .temperature(properties.temperature())
                .maxTokens(properties.maxTokens())
                .timeout(properties.timeout())
                // 请求/响应日志默认开，便于排查「模型到底看到了什么」；
                // 注意它会把 prompt 打到 INFO 级，生产环境请设为 false。
                .logRequests(properties.logRequests())
                .logResponses(properties.logRequests())
                .build();
    }

    /**
     * 供 Agent 使用的模型访问点。Bean 可能为 null（未配置模型），
     * 这里收敛成「要么拿到模型，要么抛出带明确错误码的异常」，避免到处判空。
     */
    @Bean
    public ModelGateway modelGateway(OpenAiStreamingChatModel model, LlmProperties properties) {
        return new ModelGateway(model, properties);
    }

    /** 模型访问的薄封装。 */
    public static class ModelGateway {

        private final StreamingChatModel model;
        private final LlmProperties properties;

        ModelGateway(StreamingChatModel model, LlmProperties properties) {
            this.model = model;
            this.properties = properties;
        }

        public StreamingChatModel require() {
            if (model == null) {
                throw new ApiException(ErrorCode.LLM_NOT_CONFIGURED,
                        "后端未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，无法发起对话");
            }
            return model;
        }

        public LlmProperties properties() {
            return properties;
        }

        public String modelName() {
            return properties.model();
        }

        public boolean configured() {
            return model != null;
        }
    }
}
