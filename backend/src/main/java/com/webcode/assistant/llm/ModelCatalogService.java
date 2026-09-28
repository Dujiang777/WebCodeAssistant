package com.webcode.assistant.llm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.security.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 模型目录：把「平台预置模型」和「用户自带密钥的模型」合成一份可选项清单。
 *
 * <p>三条不变量，全类都在维护它们：
 * <ol>
 *   <li><b>平台密钥不进数据库。</b>平台行的 {@code api_key_env} 只存环境变量名，
 *       用的时候现取。库被拖走时平台自己的 Key 不会跟着泄漏。</li>
 *   <li><b>用户密钥不进前端。</b>对外只给尾号（{@code ****a1b2}），
 *       明文只在 {@link ResolvedModel} 里流转，那个对象不出 Controller。</li>
 *   <li><b>不可用的模型也列出来，但标明原因。</b>直接藏掉会让用户以为
 *       「这平台就这几个模型」；列出来并写「平台未配置密钥，可自带 Key」，
 *       才是真的给了选择权。</li>
 * </ol>
 */
@Service
public class ModelCatalogService {

    private static final Logger log = LoggerFactory.getLogger(ModelCatalogService.class);

    /**
     * 单个用户最多添加多少个自带服务商。
     *
     * <p>限流不是为了省资源（这些表很小），而是防止「往目录里灌几千个 provider」
     * 把模型列表接口拖垮 —— 那个接口每次对话前都会被前端调一次。
     */
    private static final int MAX_USER_PROVIDERS = 8;

    /** 单个自带服务商最多挂多少个模型。 */
    private static final int MAX_MODELS_PER_PROVIDER = 30;

    private final LlmCatalogRepository catalog;
    private final SecretCipher cipher;
    private final LlmProperties llmProperties;
    private final AppProperties appProperties;
    private final UserRepository userRepository;

    public ModelCatalogService(LlmCatalogRepository catalog,
                               SecretCipher cipher,
                               LlmProperties llmProperties,
                               AppProperties appProperties,
                               UserRepository userRepository) {
        this.catalog = catalog;
        this.cipher = cipher;
        this.llmProperties = llmProperties;
        this.appProperties = appProperties;
        this.userRepository = userRepository;
    }

    // ------------------------------------------------------------ 对外的选项视图

    /**
     * 给界面看的模型选项。
     *
     * <p>{@code available=false} 时不可选，{@code unavailableReason} 说明为什么
     * —— 「平台未配置密钥，可在设置里填自己的 Key」这种话必须由后端给，
     * 前端猜不出来是「没配 key」还是「服务商被停用」。
     */
    public record ModelOption(
            long id,
            String modelKey,
            String displayName,
            String tier,
            String providerCode,
            String providerName,
            boolean byok,
            boolean available,
            String unavailableReason,
            long per1kInput,
            long per1kOutput,
            Integer contextWindow,
            String note
    ) {
    }

    /** 服务商 + 它下面的模型，供「模型设置」页展示。 */
    public record ProviderView(
            long id,
            String scope,
            String code,
            String name,
            String baseUrl,
            String homepage,
            String apiKeyHint,
            boolean enabled,
            boolean ready,
            String unavailableReason,
            List<ModelOption> models
    ) {
    }

    // ------------------------------------------------------------ 解析

    /**
     * 解析本轮实际要用的模型。
     *
     * <p>优先级：<b>显式指定 → 用户默认 → 平台默认（跟随 LLM_MODEL 环境变量）→ 第一个可用</b>。
     * 逐级回退而不是「找不到就报错」，是因为前端的模型选择是「尽力而为」的：
     * 用户上次选的模型可能已经被下架，那时候对话应该照常跑，而不是弹一个配置错误。
     */
    public ResolvedModel resolve(long userId, String requestedKey) {
        List<ResolvedModel> usable = new ArrayList<>();
        for (LlmCatalogRepository.ModelRow row : catalog.listVisibleModels(userId)) {
            resolveRow(row).ifPresent(usable::add);
        }
        if (usable.isEmpty()) {
            throw new ApiException(ErrorCode.LLM_NOT_CONFIGURED,
                    "没有可用的模型：平台尚未配置任何服务商密钥，你也可以在「模型设置」里填入自己的 API Key");
        }

        if (requestedKey != null && !requestedKey.isBlank()) {
            for (ResolvedModel model : usable) {
                if (model.modelKey().equals(requestedKey)) {
                    return model;
                }
            }
            // 指定的模型不可用（被下架 / 密钥被删 / 不是他的）——降级到默认，不打断对话
            log.warn("请求的模型不可用，降级到默认模型 userId={} requested={}", userId, requestedKey);
        }

        Optional<String> preferred = userDefaultModelKey(userId);
        if (preferred.isPresent()) {
            for (ResolvedModel model : usable) {
                if (model.modelKey().equals(preferred.get())) {
                    return model;
                }
            }
        }

        if (llmProperties.model() != null && !llmProperties.model().isBlank()) {
            for (ResolvedModel model : usable) {
                if (model.modelKey().equals(llmProperties.model())) {
                    return model;
                }
            }
        }

        // 兜底顺序：平台模型优先（有套餐定价兜着），其次用户自带的
        return usable.stream()
                .filter(model -> !model.providerCode().startsWith("custom"))
                .findFirst()
                .orElse(usable.getFirst());
    }

    /** 平铺的模型清单（含不可用项），供前端分组展示。 */
    public List<ModelOption> options(long userId) {
        List<ModelOption> result = new ArrayList<>();
        for (LlmCatalogRepository.ModelRow row : catalog.listVisibleModels(userId)) {
            ResolvedModel resolved = resolveRow(row).orElse(null);
            String reason = resolved == null ? unavailableReason(row) : null;
            result.add(toOption(row, resolved != null, reason));
        }
        // 平台可用模型排在前面；不可用的沉底 —— 用户第一眼该看到能用的
        result.sort(Comparator
                .comparing((ModelOption option) -> !option.available())
                .thenComparing(ModelOption::byok)
                .thenComparingLong(ModelOption::per1kOutput));
        return result;
    }

    /** 至少有一个可用模型（健康检查与对话前置判断都用它）。 */
    public boolean anyAvailable(long userId) {
        return catalog.listVisibleModels(userId).stream().anyMatch(row -> resolveRow(row).isPresent());
    }

    /** 平台侧是否有任何可用模型（不带用户视角，健康检查用）。 */
    public boolean platformConfigured() {
        return platformDefaultModelName() != null;
    }

    /**
     * 平台默认模型的显示名，健康检查与顶栏用它。
     *
     * <p>优先返回与 {@code LLM_MODEL} 环境变量同名的那个 —— 部署时配的是哪个模型，
     * 界面上就该显示哪个。都没配时退到第一个可用的平台模型。没有任何可用模型时返回 null。
     */
    public String platformDefaultModelName() {
        ResolvedModel fallback = null;
        for (LlmCatalogRepository.ModelRow row : catalog.listAllPlatformModels()) {
            if (!row.provider().platform()) {
                continue;
            }
            ResolvedModel resolved = resolveRow(row).orElse(null);
            if (resolved == null) {
                continue;
            }
            if (fallback == null) {
                fallback = resolved;
            }
            String wanted = llmProperties.model();
            if (wanted != null && !wanted.isBlank() && resolved.modelKey().equals(wanted)) {
                return resolved.displayName();
            }
        }
        return fallback == null ? null : fallback.displayName();
    }

    /** 当前解析出来的默认模型名，用于健康检查与顶栏展示。 */
    public String defaultModelKey(long userId) {
        return resolve(userId, null).modelKey();
    }

    /** 用户在「模型设置」里选定的默认模型。为空则跟随平台默认。 */
    public Optional<String> userDefaultModelKey(long userId) {
        return userRepository.findDefaultModelKey(userId);
    }

    /**
     * 记住用户的选择，下次开新会话直接用它。
     *
     * <p>校验要落在「<b>此刻真的可用</b>」上，而不是「目录里存在」：
     * 把默认模型设成一个平台没配密钥的模型，用户下次对话会莫名其妙地拿到降级结果，
     * 而他以为自己已经选好了。这里直接拒掉，比事后解释便宜得多。
     */
    @Transactional
    public void setUserDefaultModel(long userId, String modelKey) {
        String key = trimToNull(modelKey);
        if (key == null) {
            userRepository.updateDefaultModelKey(userId, null);
            return;
        }
        boolean usable = options(userId).stream()
                .anyMatch(option -> option.available() && option.modelKey().equals(key));
        if (!usable) {
            throw new ApiException(ErrorCode.NOT_FOUND,
                    "「" + key + "」当前不可用（平台未配置它的密钥，或它不是你的模型），无法设为默认");
        }
        userRepository.updateDefaultModelKey(userId, key);
    }

    // ------------------------------------------------------------ 服务商视图

    public List<ProviderView> providers(long userId) {
        Map<Long, List<LlmCatalogRepository.Model>> modelsByProvider = new LinkedHashMap<>();
        for (LlmCatalogRepository.ModelRow row : catalog.listVisibleModels(userId)) {
            modelsByProvider.computeIfAbsent(row.provider().id(), key -> new ArrayList<>()).add(row.model());
        }
        List<ProviderView> views = new ArrayList<>();
        for (LlmCatalogRepository.Provider provider : catalog.listVisibleProviders(userId)) {
            String reason = providerAvailabilityReason(provider);
            List<ModelOption> models = new ArrayList<>();
            for (LlmCatalogRepository.Model model : modelsByProvider.getOrDefault(provider.id(), List.of())) {
                boolean ready = reason == null;
                models.add(toOption(new LlmCatalogRepository.ModelRow(model, provider), ready, reason));
            }
            views.add(new ProviderView(provider.id(), provider.scope(), provider.code(), provider.name(),
                    provider.baseUrl(), provider.homepage(), provider.apiKeyHint(), provider.enabled(),
                    reason == null, reason, models));
        }
        return views;
    }

    // ------------------------------------------------------------ 用户自带服务商的增删改

    /** 新增时用户提交的内容。 */
    public record ProviderInput(String name, String baseUrl, String apiKey, String homepage,
                                List<String> models) {
    }

    @Transactional
    public long addProvider(long userId, ProviderInput input) {
        if (catalog.countUserProviders(userId) >= MAX_USER_PROVIDERS) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "自带服务商最多 " + MAX_USER_PROVIDERS + " 个，请先删除不用的");
        }
        String name = require(input.name(), "名称");
        String baseUrl = normalizeBaseUrl(input.baseUrl());
        String apiKey = require(input.apiKey(), "API Key");
        List<String> models = normalizeModels(input.models());
        if (models.isEmpty()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "至少要填一个模型名");
        }
        if (models.size() > MAX_MODELS_PER_PROVIDER) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED,
                    "一个服务商最多挂 " + MAX_MODELS_PER_PROVIDER + " 个模型");
        }

        // code 只是用户自己看的稳定标识（custom / custom-2 …），唯一键是 scope+owner+code。
        // 逐个试到空位为止：删了 custom-1 再加一个，会重新用回 custom-1，行为可预期。
        String code = null;
        for (int suffix = 1; suffix <= 99; suffix++) {
            String candidate = suffix == 1 ? "custom" : "custom-" + suffix;
            if (!providerCodeTaken(userId, candidate)) {
                code = candidate;
                break;
            }
        }
        if (code == null) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "无法分配服务商标识，请先删除不用的服务商");
        }

        long providerId = catalog.insertUserProvider(userId, code, name, baseUrl,
                cipher.encrypt(apiKey), cipher.hint(apiKey), trimToNull(input.homepage()));
        for (String modelKey : models) {
            catalog.insertUserModel(providerId, modelKey, modelKey, ResolvedModel.TIER_STANDARD,
                    true, null, "自带 Key");
        }
        log.info("用户添加自带模型服务商 userId={} providerId={} code={} models={}",
                userId, providerId, code, models.size());
        return providerId;
    }

    @Transactional
    public void updateProvider(long userId, long providerId, ProviderInput input) {
        // 先做归属校验：不是自己的服务商，后面一个字段都不该被读到
        requireOwn(userId, providerId);
        String name = require(input.name(), "名称");
        String baseUrl = normalizeBaseUrl(input.baseUrl());
        // 密钥留空 = 不改。界面上密钥只回显尾号，没法「原样提交」。
        String apiKey = trimToNull(input.apiKey());
        String enc = apiKey == null ? null : cipher.encrypt(apiKey);
        String hint = apiKey == null ? null : cipher.hint(apiKey);

        catalog.updateUserProvider(providerId, userId, name, baseUrl, enc, hint,
                trimToNull(input.homepage()), true);

        if (apiKey != null) {
            log.info("用户更新了自带服务商密钥 userId={} providerId={}", userId, providerId);
        }

        // 模型列表给了就整体替换：一个「模型名写错了」的修补动作，
        // 拆成增/删两个接口只会让前端写更多状态机。
        List<String> models = input.models() == null ? List.of() : normalizeModels(input.models());
        if (!models.isEmpty()) {
            List<String> existingKeys = catalog.listUserModels(providerId).stream()
                    .map(LlmCatalogRepository.Model::modelKey).toList();
            for (String modelKey : models) {
                if (!existingKeys.contains(modelKey)) {
                    catalog.insertUserModel(providerId, modelKey, modelKey,
                            ResolvedModel.TIER_STANDARD, true, null, "自带 Key");
                }
            }
        }
    }

    @Transactional
    public void deleteProvider(long userId, long providerId) {
        requireOwn(userId, providerId);
        // llm_models 有 on delete cascade，模型会跟着走 —— 这也是外键存在的意义
        catalog.deleteUserProvider(providerId, userId);
        log.info("用户删除自带服务商 userId={} providerId={}", userId, providerId);
    }

    private LlmCatalogRepository.Provider requireOwn(long userId, long providerId) {
        LlmCatalogRepository.Provider provider = catalog.findOwnProvider(providerId, userId)
                .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "服务商不存在或不属于你"));
        return provider;
    }

    // ------------------------------------------------------------ 内部：可用性

    /**
     * 把目录行解析成可调用的模型；不可用返回空。
     */
    private Optional<ResolvedModel> resolveRow(LlmCatalogRepository.ModelRow row) {
        LlmCatalogRepository.Provider provider = row.provider();
        String key = provider.platform() ? platformKey(provider) : cipher.decrypt(provider.apiKeyEnc());
        if (key == null || key.isBlank()) {
            return Optional.empty();
        }
        boolean byok = !provider.platform();
        boolean billable = !(byok && appProperties.credit().byokFree());
        return Optional.of(new ResolvedModel(
                row.model().id(),
                row.model().modelKey(),
                row.model().displayName(),
                row.model().tier(),
                provider.id(),
                provider.code(),
                provider.name(),
                provider.baseUrl(),
                key,
                billable,
                row.model().per1kInput(),
                row.model().per1kOutput(),
                row.model().supportsTools()));
    }

    private String unavailableReason(LlmCatalogRepository.ModelRow row) {
        return providerAvailabilityReason(row.provider());
    }

    private String providerAvailabilityReason(LlmCatalogRepository.Provider provider) {
        if (!provider.enabled()) {
            return "该服务商已被停用";
        }
        if (provider.baseUrl() == null || provider.baseUrl().isBlank()) {
            return "该服务商未配置接口地址";
        }
        if (provider.platform()) {
            return platformKey(provider) == null
                    ? "平台未配置该服务商的密钥，你可以在「模型设置」里填自己的 Key"
                    : null;
        }
        return cipher.decrypt(provider.apiKeyEnc()) == null
                ? "密钥无法解密（多半是服务端加密密钥被轮换过），请重新填写"
                : null;
    }

    /**
     * 平台服务商的密钥。
     *
     * <p>取值顺序：<b>自己的环境变量 → （地址与 LLM_BASE_URL 一致时）全局 LLM_API_KEY</b>。
     *
     * <p>为什么第二个条件要卡「地址一致」：部署时只配了 DeepSeek 的 Key，
     * 如果不卡地址就回退，OpenAI、通义、智谱会全部被当成「已配置」，
     * 用户选中后才会在对话时报 401 —— 那是最难解释的一种故障。
     */
    private String platformKey(LlmCatalogRepository.Provider provider) {
        String envName = provider.apiKeyEnv();
        if (envName != null && !envName.isBlank()) {
            String value = System.getenv(envName);
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        if (sameEndpoint(provider.baseUrl(), llmProperties.baseUrl())) {
            String global = llmProperties.apiKey();
            if (global != null && !global.isBlank()) {
                return global.trim();
            }
        }
        return null;
    }

    private static boolean sameEndpoint(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        return normalizeEndpoint(left).equals(normalizeEndpoint(right));
    }

    private static String normalizeEndpoint(String url) {
        String value = url.trim().toLowerCase();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private boolean providerCodeTaken(long userId, String code) {
        return catalog.listVisibleProviders(userId).stream()
                .anyMatch(provider -> provider.ownerId() != null
                        && provider.ownerId() == userId
                        && provider.code().equals(code));
    }

    // ------------------------------------------------------------ 内部：输入规整

    private ModelOption toOption(LlmCatalogRepository.ModelRow row, boolean available, String reason) {
        LlmCatalogRepository.Provider provider = row.provider();
        return new ModelOption(
                row.model().id(),
                row.model().modelKey(),
                row.model().displayName(),
                row.model().tier(),
                provider.code(),
                provider.name(),
                !provider.platform(),
                available,
                reason,
                row.model().per1kInput(),
                row.model().per1kOutput(),
                row.model().contextWindow(),
                row.model().note());
    }

    private static String require(String value, String label) {
        String trimmed = trimToNull(value);
        if (trimmed == null) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, label + "不能为空");
        }
        return trimmed;
    }

    private static String normalizeBaseUrl(String raw) {
        String value = require(raw, "接口地址");
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "接口地址必须以 http:// 或 https:// 开头");
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    /** 模型名支持逗号、换行、空格分隔，去重且保序。 */
    private static List<String> normalizeModels(List<String> raw) {
        if (raw == null) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String item : raw) {
            if (item == null) {
                continue;
            }
            for (String piece : item.split("[,\\n\\r\\s]+")) {
                String value = piece.trim();
                if (!value.isEmpty() && !result.contains(value)) {
                    result.add(value);
                }
            }
        }
        return result;
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
