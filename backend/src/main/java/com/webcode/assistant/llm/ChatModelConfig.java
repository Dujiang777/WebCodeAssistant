package com.webcode.assistant.llm;

import dev.langchain4j.model.chat.StreamingChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * 模型访问的统一入口。
 *
 * <p><b>为什么不用 {@code langchain4j-spring-boot-starter}：</b>该 starter 目前最新只到
 * {@code 1.0.0-beta5}，落后于核心库 1.0.0，混用会出现 API 不一致。这里直接用核心库 +
 * 显式装配，好处是模型参数、超时、日志开关全在一处可见。
 *
 * <p><b>V6 起不再是「一个全局模型 Bean」</b>：模型改由
 * {@link ModelCatalogService} 按用户解析，客户端由 {@link ChatModelFactory} 按需构建。
 * 原来那种写死的单例撑不住「用户可以选模型、可以自带 Key」这个需求 ——
 * 单例意味着进程里只有一把地址和一把密钥。
 *
 * <p>未配置任何模型时后端依然能启动：文件浏览与编辑照常可用，
 * 只有对话接口会返回 {@code LLM_NOT_CONFIGURED}，而不是启动即失败。
 */
@Configuration
public class ChatModelConfig {

    /** 供 Agent 使用的模型访问点。所有「取模型」的动作都收敛在这里，避免各处重复判空。 */
    @Bean
    public ModelGateway modelGateway(ModelCatalogService catalog, ChatModelFactory factory) {
        return new ModelGateway(catalog, factory);
    }

    /** 模型访问的薄封装。 */
    public static class ModelGateway {

        private final ModelCatalogService catalog;
        private final ChatModelFactory factory;

        ModelGateway(ModelCatalogService catalog, ChatModelFactory factory) {
            this.catalog = catalog;
            this.factory = factory;
        }

        /** 平台侧是否至少有一个可用模型（健康检查用，不带用户视角）。 */
        public boolean configured() {
            return catalog.platformConfigured();
        }

        /** 平台默认模型的显示名；没有任何可用模型时返回 null。 */
        public String defaultModelName() {
            return catalog.platformDefaultModelName();
        }

        /** 这个用户此刻是否有模型可用（平台可用 或 他自己填了 Key）。 */
        public boolean availableFor(long userId) {
            return catalog.anyAvailable(userId);
        }

        /**
         * 解析本轮要用的模型。永不返回 null —— 一个都没有时抛带明确错误码的异常，
         * 让用户看到「去配一个 Key」而不是一个空指针。
         */
        public ResolvedModel resolve(long userId, String modelKey) {
            return catalog.resolve(userId, modelKey);
        }

        /** 取（或构建）该模型的流式客户端。 */
        public StreamingChatModel require(ResolvedModel model) {
            return factory.get(model);
        }

        /** 界面上能看到的模型清单（含不可用项与原因）。 */
        public List<ModelCatalogService.ModelOption> options(long userId) {
            return catalog.options(userId);
        }

        /** 展示用的模型名。 */
        public String modelName(ResolvedModel model) {
            return model.displayName();
        }
    }
}
