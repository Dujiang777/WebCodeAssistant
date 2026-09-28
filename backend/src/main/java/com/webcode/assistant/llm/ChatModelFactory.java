package com.webcode.assistant.llm;

import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 按模型构建（并缓存）LangChain4j 客户端。
 *
 * <p>为什么需要缓存而不是每次现建：{@link OpenAiStreamingChatModel} 内部持有 HTTP 客户端与
 * 连接池，每次对话都新建一个等于每次都重开一遍连接池 —— 在高频使用下会明显看到
 * 首字节延迟变长。缓存键里已经包含 baseUrl 与密钥摘要，所以用户改了 Key
 * 会自动落到新实例上，不需要任何显式的失效逻辑。
 *
 * <p>容量上限 32：一个用户的模型数量上限是 8 个服务商 × 30 个模型，
 * 不设上限会让「多用户各带一堆模型」把内存吃满。用 LRU 淘汰，
 * 被淘汰的只是下次重建，没有正确性代价。
 */
@Service
public class ChatModelFactory {

    private static final Logger log = LoggerFactory.getLogger(ChatModelFactory.class);

    private static final int MAX_CACHED_MODELS = 32;

    private final LlmProperties properties;

    private final Map<String, StreamingChatModel> cache =
            Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, StreamingChatModel> eldest) {
                    return size() > MAX_CACHED_MODELS;
                }
            });

    public ChatModelFactory(LlmProperties properties) {
        this.properties = properties;
    }

    public StreamingChatModel get(ResolvedModel model) {
        return cache.computeIfAbsent(model.cacheKey(), key -> build(model));
    }

    private StreamingChatModel build(ResolvedModel model) {
        log.info("构建模型客户端: {}（{} @ {}，计费={}）",
                model.modelKey(), model.providerName(), model.baseUrl(),
                model.billable() ? model.per1kInput() + "/" + model.per1kOutput() + " 分每千 token" : "免积分（自带 Key）");
        return OpenAiStreamingChatModel.builder()
                .baseUrl(model.baseUrl())
                .apiKey(model.apiKey())
                .modelName(model.modelKey())
                .temperature(properties.temperature())
                .maxTokens(properties.maxTokens())
                .timeout(properties.timeout())
                // 请求/响应日志默认开，便于排查「模型到底看到了什么」；
                // 注意它会把 prompt 打到 INFO 级，生产环境请设 LLM_LOG_REQUESTS=false。
                .logRequests(properties.logRequests())
                .logResponses(properties.logRequests())
                .build();
    }
}
