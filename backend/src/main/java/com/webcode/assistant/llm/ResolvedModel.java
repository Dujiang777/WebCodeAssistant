package com.webcode.assistant.llm;

/**
 * 解析完成、可以直接拿去建客户端的模型。
 *
 * <p>之所以要区分「目录里的模型」和「解析后的模型」：目录里存的是<b>怎么描述</b>
 * （名字、档位、单价），而这里装的是<b>怎么调用</b>（真实 baseUrl + 明文密钥）
 * 加上<b>怎么收钱</b>（是否计费、两个单价）。
 *
 * <p>{@code apiKey} 是明文 —— 这个对象<b>只允许在后端内部流转</b>，
 * 任何 Controller 都不能直接返回它。对外一律走 {@code ApiModels.ModelOption}，
 * 那里只有尾号。
 *
 * <p>{@code billable} 与价格的关系是刻意的双重表达：{@code billable=false}
 * 表示「这轮不扣分」（自带 Key），此时单价就算有值也不会被读。
 * 让 PricingService 只看一个布尔开关，比在三个地方判断 provider 归属要可靠得多。
 *
 * @param modelId        llm_models.id
 * @param modelKey      传给模型服务的 model 名
 * @param displayName   界面上显示的名字
 * @param tier          LIGHT / STANDARD / FLAGSHIP，仅用于界面分组与默认推荐
 * @param providerId    llm_providers.id
 * @param providerCode  deepseek / openai / custom-1 …
 * @param providerName  显示用的服务商名
 * @param baseUrl       OpenAI 兼容端点
 * @param apiKey        明文密钥（内部使用）
 * @param billable      是否扣积分。false = 用户自带 Key 且平台不收费
 * @param per1kInput    每 1000 输入 token 扣多少积分
 * @param per1kOutput   每 1000 输出 token 扣多少积分
 * @param supportsTools 是否支持工具调用（不支持就不能用来改代码）
 */
public record ResolvedModel(
        long modelId,
        String modelKey,
        String displayName,
        String tier,
        long providerId,
        String providerCode,
        String providerName,
        String baseUrl,
        String apiKey,
        boolean billable,
        long per1kInput,
        long per1kOutput,
        boolean supportsTools
) {

    public static final String TIER_LIGHT = "LIGHT";
    public static final String TIER_STANDARD = "STANDARD";
    public static final String TIER_FLAGSHIP = "FLAGSHIP";

    /** 轻量档。用于给用户解释「为什么这个模型便宜」。 */
    public boolean light() {
        return TIER_LIGHT.equalsIgnoreCase(tier);
    }

    /**
     * 模型缓存键。
     *
     * <p>把 baseUrl 与密钥都编进去，是为了让「用户改了自己的 Key」这件事
     * 自动使旧客户端失效 —— 否则改了 Key 还在用旧连接打，会一直报 401，
     * 而用户看到的是「我明明改对了」。
     */
    public String cacheKey() {
        return providerId + "|" + modelKey + "|" + baseUrl + "|" + Integer.toHexString(apiKey.hashCode());
    }
}
