package com.webcode.assistant.api;

import com.webcode.assistant.agent.GrepService;
import com.webcode.assistant.llm.ChatModelConfig;
import com.webcode.assistant.llm.UsageGuard;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 健康检查。用于 Docker Compose 的 healthcheck 与前端「后端是否就绪」的提示。
 *
 * <p>暴露的信息经过筛选：只说明「模型是否已配置」和模型名，不返回 baseUrl 与 Key。
 *
 * <p>Redis 状态走一次真实探测（{@link UsageGuard#probeRedis()}）而不是读熔断标记，
 * 否则在「进程刚起、还没发过任何对话请求」时会把不可用的 Redis 报成可用。
 */
@RestController
@RequestMapping("/api")
public class HealthController {

    private final ChatModelConfig.ModelGateway modelGateway;
    private final GrepService grepService;
    private final UsageGuard usageGuard;

    public HealthController(ChatModelConfig.ModelGateway modelGateway,
                           GrepService grepService,
                           UsageGuard usageGuard) {
        this.modelGateway = modelGateway;
        this.grepService = grepService;
        this.usageGuard = usageGuard;
    }

    @GetMapping("/health")
    public ApiModels.HealthResponse health() {
        return new ApiModels.HealthResponse(
                "ok",
                modelGateway.configured(),
                modelGateway.configured() ? modelGateway.modelName() : null,
                grepService.engineName(),
                usageGuard.probeRedis());
    }
}
