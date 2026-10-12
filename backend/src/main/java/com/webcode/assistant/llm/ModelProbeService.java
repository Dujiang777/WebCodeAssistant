package com.webcode.assistant.llm;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 「试连」：用给定地址与密钥拉一次 {@code GET /models}，把可用模型名列出来。
 *
 * <p>为什么值得做这个功能：让用户手打模型名是 BYOK 体验里最容易出错的一环 ——
 * 打错一个字符，得到的是一串看不懂的 404 或空回答。OpenAI 兼容协议都有
 * {@code /v1/models}，直接列出来让他勾选，这一类故障从此不存在。
 *
 * <p><b>这本质上是一个 SSRF 面</b>（服务端替用户去请求一个用户给的地址），
 * 所以做了四层收敛，缺任何一层都不该上线：
 * <ol>
 *   <li>只允许 http/https，别的协议一律拒；</li>
 *   <li>拒绝云元数据地址（169.254.169.254 / metadata.google.internal 等）——
 *       那是这类漏洞最经典的利用目标，用一个请求换走实例凭证；</li>
 *   <li>8 秒超时 + 响应体上限 256KB，防止被当成慢速放大器或内存炸弹；</li>
 *   <li>必须登录才能调用（Controller 层保证），并且失败原因会写日志，便于事后审计。</li>
 * </ol>
 *
 * <p>刻意<b>不</b>禁止内网地址：本项目的部署形态就是「后端与模型服务常常在同一台机器上」
 * （本地 mock、内网中转都是常见用法），一刀切禁内网会把正常用法一起打死。
 * 真正该拦的是元数据端点那一类，它们只有一个用途。
 */
@Service
public class ModelProbeService {

    private static final Logger log = LoggerFactory.getLogger(ModelProbeService.class);

    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    /** 响应体上限。一个模型列表正常只有几十 KB，256KB 已经非常宽松。 */
    private static final int MAX_BODY_BYTES = 256 * 1024;

    /** 云元数据端点。它们唯一的作用就是泄漏实例身份，没有任何正常用途。 */
    private static final List<String> BLOCKED_HOSTS = List.of(
            "169.254.169.254",
            "metadata.google.internal",
            "metadata.goog",
            "100.100.100.200",          // 阿里云元数据
            "fd00:ec2::254");

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    public ModelProbeService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public record ProbeResult(boolean ok, String message, List<String> models) {
    }

    public record PingResult(boolean ok, String message, long latencyMs, String model, String sample) {
        static PingResult fail(String message, long latencyMs, String model) {
            return new PingResult(false, message, latencyMs, model == null ? "" : model, "");
        }
    }

    /**
     * 试连并列出模型。
     *
     * <p>失败不抛异常而是回 {@code ok=false} + 人话原因：这是用户点的一个「测试」按钮，
     * 把 401 说成「密钥不对」比抛一个 500 有用得多，也不会在页面上留一堆红色堆栈。
     */
    public ProbeResult probe(String rawBaseUrl, String apiKey) {
        Target target = resolveTarget(rawBaseUrl, "/models");
        if (target.error() != null) {
            return new ProbeResult(false, target.error(), List.of());
        }
        URI uri = target.uri();
        String lowerHost = uri.getHost().toLowerCase(Locale.ROOT);

        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .timeout(TIMEOUT)
                .header("Accept", "application/json")
                .GET();
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("Authorization", "Bearer " + apiKey.trim());
        }

        try {
            HttpResponse<byte[]> response = httpClient.send(builder.build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            int status = response.statusCode();
            if (status == 401 || status == 403) {
                return new ProbeResult(false, "密钥被拒绝（HTTP " + status + "），请检查 Key 是否正确", List.of());
            }
            if (status == 404) {
                return new ProbeResult(false,
                        "该地址没有 /models 端点（HTTP 404）。确认地址是否要带 /v1 后缀", List.of());
            }
            if (status < 200 || status >= 300) {
                return new ProbeResult(false, "上游返回 HTTP " + status, List.of());
            }
            byte[] body = response.body();
            if (body == null || body.length == 0) {
                return new ProbeResult(false, "上游返回空响应", List.of());
            }
            if (body.length > MAX_BODY_BYTES) {
                return new ProbeResult(false, "模型列表过大，已忽略", List.of());
            }
            List<String> models = parseModelIds(new String(body, StandardCharsets.UTF_8));
            if (models.isEmpty()) {
                return new ProbeResult(false, "连上了，但没有解析出模型名；可以直接手动填写模型名", List.of());
            }
            log.info("试连成功 host={} models={}", lowerHost, models.size());
            return new ProbeResult(true, "连上了，共 " + models.size() + " 个模型", models);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return new ProbeResult(false, "试连被中断", List.of());
        } catch (Exception ex) {
            String message = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            log.warn("试连失败 host={} error={}", lowerHost, message);
            return new ProbeResult(false, "连不上：" + message, List.of());
        }
    }

    /**
     * 试一句：发一条极短的 {@code /chat/completions}，确认 Key 真能说话。
     *
     * <p>{@code GET /models} 过了不等于能对话 —— 不少中转站目录是开的、补全是关的，
     * 或者模型名写错。这里用 8 个 token 的非流式请求验证，不走积分、不进对话历史。
     */
    public PingResult ping(String rawBaseUrl, String apiKey, String model) {
        String modelName = model == null ? "" : model.trim();
        if (modelName.isBlank()) {
            return PingResult.fail("先选一个模型再试一句", 0, "");
        }
        Target target = resolveTarget(rawBaseUrl, "/chat/completions");
        if (target.error() != null) {
            return PingResult.fail(target.error(), 0, modelName);
        }
        URI uri = target.uri();
        String lowerHost = uri.getHost().toLowerCase(Locale.ROOT);
        long started = System.nanoTime();

        byte[] payload;
        try {
            payload = objectMapper.writeValueAsBytes(java.util.Map.of(
                    "model", modelName,
                    "messages", java.util.List.of(java.util.Map.of("role", "user", "content", "只回 ok")),
                    "max_tokens", 8,
                    "stream", false));
        } catch (Exception ex) {
            return PingResult.fail("无法组装探测请求", 0, modelName);
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(12))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(payload));
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("Authorization", "Bearer " + apiKey.trim());
        }

        try {
            HttpResponse<byte[]> response = httpClient.send(builder.build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            long latencyMs = (System.nanoTime() - started) / 1_000_000L;
            int status = response.statusCode();
            if (status == 401 || status == 403) {
                return PingResult.fail("密钥被拒绝（HTTP " + status + "），请检查 Key 是否正确", latencyMs, modelName);
            }
            if (status == 404) {
                return PingResult.fail("该地址没有 /chat/completions（HTTP 404）。确认地址是否要带 /v1", latencyMs, modelName);
            }
            byte[] body = response.body() == null ? new byte[0] : response.body();
            if (body.length > MAX_BODY_BYTES) {
                return PingResult.fail("探测响应过大，已忽略", latencyMs, modelName);
            }
            String text = new String(body, StandardCharsets.UTF_8);
            if (status < 200 || status >= 300) {
                return PingResult.fail(upstreamError(text, status), latencyMs, modelName);
            }
            String sample = parseCompletion(text);
            log.info("试一句成功 host={} model={} {}ms", lowerHost, modelName, latencyMs);
            if (sample.isBlank()) {
                return new PingResult(true, "连上了，接口可用 · " + latencyMs + "ms", latencyMs, modelName, "");
            }
            return new PingResult(true,
                    "连上了，模型回了「" + sample + "」· " + latencyMs + "ms",
                    latencyMs, modelName, sample);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return PingResult.fail("试一句被中断", (System.nanoTime() - started) / 1_000_000L, modelName);
        } catch (Exception ex) {
            String message = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            log.warn("试一句失败 host={} model={} error={}", lowerHost, modelName, message);
            return PingResult.fail("连不上：" + message, (System.nanoTime() - started) / 1_000_000L, modelName);
        }
    }

    private record Target(URI uri, String error) {
        static Target bad(String error) {
            return new Target(null, error);
        }
    }

    private Target resolveTarget(String rawBaseUrl, String path) {
        String baseUrl;
        try {
            baseUrl = normalize(rawBaseUrl);
        } catch (ApiException ex) {
            return Target.bad(ex.getMessage());
        }
        URI uri;
        try {
            uri = URI.create(baseUrl + path);
        } catch (RuntimeException ex) {
            return Target.bad("接口地址格式不对");
        }
        String host = uri.getHost();
        if (host == null) {
            return Target.bad("接口地址里没有主机名");
        }
        String lowerHost = host.toLowerCase(Locale.ROOT);
        if (BLOCKED_HOSTS.contains(lowerHost)) {
            log.warn("拒绝探测云元数据地址: {}", lowerHost);
            return Target.bad("该地址不被允许");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            return Target.bad("只支持 http 或 https 地址");
        }
        return new Target(uri, null);
    }

    private String parseCompletion(String body) {
        try {
            JsonNode root = objectMapper.readTree(body);
            JsonNode choices = root.path("choices");
            if (!choices.isArray() || choices.isEmpty()) {
                return "";
            }
            JsonNode first = choices.get(0);
            String content = first.path("message").path("content").asText("");
            if (content.isBlank()) {
                content = first.path("text").asText("");
            }
            return clipSample(content);
        } catch (Exception ex) {
            return "";
        }
    }

    private String upstreamError(String body, int status) {
        try {
            JsonNode root = objectMapper.readTree(body);
            String message = root.path("error").path("message").asText("");
            if (message.isBlank()) {
                message = root.path("message").asText("");
            }
            if (!message.isBlank()) {
                return clipSample(message) + "（HTTP " + status + "）";
            }
        } catch (Exception ignored) {
            // 上游不是 JSON 时只报状态码
        }
        return "上游返回 HTTP " + status;
    }

    private static String clipSample(String raw) {
        String value = raw.replaceAll("\\s+", " ").trim();
        if (value.length() > 80) {
            return value.substring(0, 80) + "…";
        }
        return value;
    }

    /** 解析 OpenAI 兼容的 {@code {"data":[{"id":"..."}]}}。兼容直接给数组的写法。 */
    private List<String> parseModelIds(String body) {
        List<String> result = new ArrayList<>();
        try {
            JsonNode root = objectMapper.readTree(body);
            JsonNode array = root.isArray() ? root : root.path("data");
            if (!array.isArray()) {
                array = root.path("models");
            }
            if (array.isArray()) {
                for (JsonNode node : array) {
                    String id = node.isTextual() ? node.asText() : node.path("id").asText(null);
                    if (id != null && !id.isBlank() && !result.contains(id)) {
                        result.add(id);
                    }
                }
            }
        } catch (Exception ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "模型列表不是合法 JSON");
        }
        return result;
    }

    private static String normalize(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new ApiException(ErrorCode.VALIDATION_FAILED, "接口地址不能为空");
        }
        String value = raw.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }
}
