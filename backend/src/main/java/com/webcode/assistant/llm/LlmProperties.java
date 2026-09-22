package com.webcode.assistant.llm;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;
import java.util.List;

/**
 * 模型与用量配置。全部走环境变量，任何情况下都不允许下发给前端。
 *
 * <p>只要求「OpenAI 兼容」：DeepSeek、硅基流动、各类中转、官方 OpenAI 都只是
 * baseUrl / model 不同，代码无需改动。
 */
@ConfigurationProperties(prefix = "llm")
public record LlmProperties(

        /** 例如 https://api.deepseek.com/v1 ，留空则视为未配置。 */
        @DefaultValue("") String baseUrl,

        @DefaultValue("") String apiKey,

        /** 例如 deepseek-chat / gpt-4o-mini / Qwen/Qwen2.5-Coder-32B-Instruct 。 */
        @DefaultValue("") String model,

        /**
         * embedding 模型名（OpenAI 兼容 /v1/embeddings）。留空表示语义检索不可用 ——
         * 语义检索降级为明确报错而不是静默装死；正则 grep 不受影响。
         */
        @DefaultValue("") String embeddingModel,

        @DefaultValue("0.2") Double temperature,

        @DefaultValue("8192") Integer maxTokens,

        @DefaultValue("PT120S") Duration timeout,

        @DefaultValue("true") Boolean logRequests,

        /** 每用户每秒请求数上限。 */
        @DefaultValue("2") Integer requestsPerSecond,

        /** 每用户每日 token 上限（输入 + 输出）。 */
        @DefaultValue("500000") Long dailyTokenLimit,

        /** 注入 system prompt 的项目规则文件候选名，命中即注入。 */
        @DefaultValue({".coding-rules.md", ".coding-rules", "AGENTS.md", "CLAUDE.md"})
        List<String> ruleFiles,

        /** 最近带入上下文的历史消息条数。 */
        @DefaultValue("12") Integer historyMessages,

        /** 单轮 Agent 最大工具调用步数，防止死循环烧 token。 */
        @DefaultValue("12") Integer maxToolSteps,

        /**
         * 当前打开文件注入 prompt 的字符上限。
         * 默认 4 万字符（约 1 万 token），足够覆盖绝大多数单文件，又不会把预算吃光。
         */
        @DefaultValue("40000") Integer contextFileChars,

        /** 选中代码注入 prompt 的字符上限。 */
        @DefaultValue("8000") Integer contextSelectionChars
) {

    /** 未配置模型时后端仍可启动，但对话接口会明确报错而不是静默失败。 */
    public boolean isConfigured() {
        return baseUrl != null && !baseUrl.isBlank()
                && apiKey != null && !apiKey.isBlank()
                && model != null && !model.isBlank();
    }
}
