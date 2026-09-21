package com.webcode.assistant.agent;

import dev.langchain4j.service.TokenStream;

/**
 * LangChain4j AiService 接口。
 *
 * <p>只有一个参数、且不带任何注解 —— 这是 LangChain4j 约定的「整个参数就是用户消息」写法。
 * system prompt 与历史消息由我们自己在 {@link AgentOrchestrator} 里预先塞进 ChatMemory，
 * 这样消息顺序严格是 {@code [System, 历史..., 本轮用户消息]}，不会出现 system prompt
 * 被追加到对话中间的情况。
 */
public interface Assistant {

    TokenStream chat(String userMessage);
}
