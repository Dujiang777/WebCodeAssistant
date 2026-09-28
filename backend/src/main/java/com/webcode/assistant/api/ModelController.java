package com.webcode.assistant.api;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.config.AppProperties;
import com.webcode.assistant.llm.LlmCatalogRepository;
import com.webcode.assistant.llm.ModelCatalogService;
import com.webcode.assistant.llm.ModelProbeService;
import com.webcode.assistant.llm.SecretCipher;
import com.webcode.assistant.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 模型目录与自带密钥（BYOK）。
 *
 * <p>所有端点都<b>只作用于当前登录用户</b>：userId 一律从 {@link CurrentUser} 取，
 * 不接受请求参数里传 userId —— 一旦接受，「读取别人的模型配置」就变成了一个功能。
 *
 * <p>这个 Controller 是密钥泄漏面最大的地方（因为它是唯一会碰密钥的对外接口），
 * 所以有一条硬规则：<b>任何响应体里都不允许出现明文密钥或加密串</b>，
 * 只有 {@link ApiModels.ProviderView#apiKeyHint()} 那个尾号。
 */
@RestController
@RequestMapping("/api/models")
public class ModelController {

    private final ModelCatalogService catalogService;
    private final ModelProbeService probeService;
    private final LlmCatalogRepository catalogRepository;
    private final SecretCipher cipher;
    private final AppProperties appProperties;
    private final CurrentUser currentUser;

    public ModelController(ModelCatalogService catalogService,
                           ModelProbeService probeService,
                           LlmCatalogRepository catalogRepository,
                           SecretCipher cipher,
                           AppProperties appProperties,
                           CurrentUser currentUser) {
        this.catalogService = catalogService;
        this.probeService = probeService;
        this.catalogRepository = catalogRepository;
        this.cipher = cipher;
        this.appProperties = appProperties;
        this.currentUser = currentUser;
    }

    /** 模型设置页一次拿全：可选模型、服务商明细（含密钥尾号）、当前默认。 */
    @GetMapping
    public ApiModels.ModelCatalogResponse catalog() {
        long userId = currentUser.require().userId();
        List<ApiModels.ModelOptionView> models = catalogService.options(userId).stream()
                .map(ModelController::toOption)
                .toList();
        List<ApiModels.ProviderView> providers = catalogService.providers(userId).stream()
                .map(provider -> new ApiModels.ProviderView(
                        provider.id(), provider.scope(), provider.code(), provider.name(),
                        provider.baseUrl(), provider.homepage(), provider.apiKeyHint(),
                        provider.enabled(), provider.ready(), provider.unavailableReason(),
                        provider.models().stream().map(ModelController::toOption).toList()))
                .toList();
        return new ApiModels.ModelCatalogResponse(
                models,
                providers,
                catalogService.userDefaultModelKey(userId).orElse(null),
                catalogService.anyAvailable(userId),
                appProperties.credit().byokFree(),
                appProperties.credit().signupBonus());
    }

    @PostMapping("/providers")
    public ApiModels.ProviderView addProvider(@Valid @RequestBody ApiModels.SaveProviderRequest request) {
        long userId = currentUser.require().userId();
        long providerId = catalogService.addProvider(userId, toInput(request));
        return providerView(userId, providerId);
    }

    @PutMapping("/providers/{providerId}")
    public ApiModels.ProviderView updateProvider(@PathVariable long providerId,
                                                @Valid @RequestBody ApiModels.SaveProviderRequest request) {
        long userId = currentUser.require().userId();
        catalogService.updateProvider(userId, providerId, toInput(request));
        return providerView(userId, providerId);
    }

    @DeleteMapping("/providers/{providerId}")
    public void deleteProvider(@PathVariable long providerId) {
        catalogService.deleteProvider(currentUser.require().userId(), providerId);
    }

    /**
     * 试连：拉一次模型列表。
     *
     * <p>{@code apiKey} 留空时用该服务商已保存的密钥 —— 编辑已有服务商时不必重新粘贴。
     * 只允许读<b>自己的</b>服务商密钥，所以带上 {@code providerId} 时会先做归属校验。
     */
    @PostMapping("/providers/probe")
    public ApiModels.ProbeModelsResponse probe(@Valid @RequestBody ApiModels.ProbeModelsRequest request) {
        long userId = currentUser.require().userId();
        String apiKey = request.apiKey();
        if ((apiKey == null || apiKey.isBlank()) && request.providerId() != null) {
            LlmCatalogRepository.Provider provider = catalogRepository
                    .findOwnProvider(request.providerId(), userId)
                    .orElseThrow(() -> new ApiException(ErrorCode.NOT_FOUND, "服务商不存在或不属于你"));
            apiKey = cipher.decrypt(provider.apiKeyEnc());
        }
        ModelProbeService.ProbeResult result = probeService.probe(request.baseUrl(), apiKey);
        return new ApiModels.ProbeModelsResponse(result.ok(), result.message(), result.models());
    }

    /** 设为默认模型。传空 modelKey 表示恢复「跟随平台默认」。 */
    @PutMapping("/default")
    public ApiModels.ModelCatalogResponse setDefault(@Valid @RequestBody ApiModels.DefaultModelRequest request) {
        long userId = currentUser.require().userId();
        catalogService.setUserDefaultModel(userId, request.modelKey());
        return catalog();
    }

    // ------------------------------------------------------------- 组装

    private ApiModels.ProviderView providerView(long userId, long providerId) {
        return catalogService.providers(userId).stream()
                .filter(provider -> provider.id() == providerId)
                .findFirst()
                .map(provider -> new ApiModels.ProviderView(
                        provider.id(), provider.scope(), provider.code(), provider.name(),
                        provider.baseUrl(), provider.homepage(), provider.apiKeyHint(),
                        provider.enabled(), provider.ready(), provider.unavailableReason(),
                        provider.models().stream().map(ModelController::toOption).toList()))
                .orElseThrow(() -> new ApiException(ErrorCode.INTERNAL_ERROR, "服务商保存后未能读回"));
    }

    private static ModelCatalogService.ProviderInput toInput(ApiModels.SaveProviderRequest request) {
        return new ModelCatalogService.ProviderInput(
                request.name(), request.baseUrl(), request.apiKey(), request.homepage(), request.models());
    }

    private static ApiModels.ModelOptionView toOption(ModelCatalogService.ModelOption option) {
        return new ApiModels.ModelOptionView(
                option.id(), option.modelKey(), option.displayName(), option.tier(),
                option.providerCode(), option.providerName(), option.byok(),
                option.available(), option.unavailableReason(),
                option.per1kInput(), option.per1kOutput(), option.contextWindow(), option.note());
    }
}
