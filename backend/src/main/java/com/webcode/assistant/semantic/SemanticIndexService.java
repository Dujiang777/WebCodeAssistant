package com.webcode.assistant.semantic;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.llm.LlmProperties;
import com.webcode.assistant.workspace.IgnoreRules;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspaceFileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 语义检索（功能 11）：把工作区代码切块、调 OpenAI 兼容 embeddings 接口取向量、
 * 查询时做余弦相似度排序。
 *
 * <p><b>为什么不上向量索引</b>：单工作区的块数量级是几百到几千，Java 侧全量余弦
 * 是毫秒级 —— 为了这个量级要求用户给数据库装扩展不值得。向量存 json 列，开箱即用。
 *
 * <p><b>为什么embedding不可用时要明确报错</b>：与编译闭环的 {@code unavailable} 同一哲学 ——
 * 降级可以，装死不行。未配置 embedding 模型时检索接口返回 unavailable 并解释原因。
 *
 * <p><b>切块策略</b>：按行切块（每块约 50 行），跳过忽略目录（node_modules / target …）
 * 与超大文件（>512KB 不切块 —— 那些多半是生成物）。索引是显式的：
 * 用户点「重建索引」时全量重算，不追踪文件变更（保持简单，与 Spring 地图同一策略）。
 */
@Service
public class SemanticIndexService {

    private static final Logger log = LoggerFactory.getLogger(SemanticIndexService.class);

    /** 每块的目标行数。50 行 ≈ 一个完整的小函数或大函数的一半，粒度适中。 */
    private static final int CHUNK_LINES = 50;

    /** 单块字符上限，超出直接丢弃（防止把 minified 文件灌进向量库）。 */
    private static final int MAX_CHUNK_CHARS = 8000;

    /** 单文件读取上限：与补丁可编辑上限一致。 */
    private static final long MAX_FILE_BYTES = 512L * 1024;

    /** 切块中间表示。 */
    private record Chunk(String path, int startLine, int endLine, String content) {
    }

    /** 默认返回条数。 */
    private static final int DEFAULT_TOP_K = 8;

    private final JdbcClient jdbc;
    private final LlmProperties llmProperties;
    private final WorkspaceFileService fileService;
    private final ObjectMapper objectMapper;
    private final HttpClient http;

    public SemanticIndexService(JdbcClient jdbc,
                                LlmProperties llmProperties,
                                WorkspaceFileService fileService,
                                ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.llmProperties = llmProperties;
        this.fileService = fileService;
        this.objectMapper = objectMapper;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /** embedding 模型是否可用。 */
    public boolean available() {
        return llmProperties.embeddingModel() != null && !llmProperties.embeddingModel().isBlank()
                && llmProperties.baseUrl() != null && !llmProperties.baseUrl().isBlank();
    }

    /** 当前索引的块数。 */
    public int chunkCount(long workspaceId) {
        return jdbc.sql("select count(*) from code_chunks where workspace_id = :workspaceId")
                .param("workspaceId", workspaceId)
                .query(Integer.class)
                .single();
    }

    /**
     * 重建索引：删除旧块 → 全部切块 → 批量取向量 → 落库。
     *
     * @return 索引的块数
     */
    public int reindex(Workspace workspace) {
        if (!available()) {
            throw new ApiException(ErrorCode.BAD_REQUEST,
                    "语义检索不可用：未配置 embedding 模型（LLM_EMBED_MODEL）。正则 grep 不受影响。");
        }
        Path root = fileService.rootOf(workspace).toAbsolutePath().normalize();

        List<Chunk> chunks = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path file : walk.filter(Files::isRegularFile).toList()) {
                String relative = root.relativize(file).toString().replace('\\', '/');
                if (isIgnoredPath(relative) || Files.size(file) > MAX_FILE_BYTES) {
                    continue;
                }
                String text;
                try {
                    text = Files.readString(file);
                } catch (Exception ex) {
                    // 二进制或编码异常的文件跳过 —— 不是所有文件都能切块
                    continue;
                }
                chunks.addAll(chunkFile(relative, text));
                if (chunks.size() > 20000) {
                    throw new ApiException(ErrorCode.WORKSPACE_TOO_LARGE, "工作区过大，无法语义索引");
                }
            }
        } catch (java.io.IOException ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "遍历工作区失败: " + ex.getMessage(), ex);
        }
        if (chunks.isEmpty()) {
            jdbc.sql("delete from code_chunks where workspace_id = :workspaceId")
                    .param("workspaceId", workspace.id())
                    .update();
            return 0;
        }

        // 批量取向量：每批 32 条，控制请求体体积
        List<float[]> vectors = new ArrayList<>(chunks.size());
        for (int from = 0; from < chunks.size(); from += 32) {
            List<String> batch = chunks.subList(from, Math.min(from + 32, chunks.size())).stream()
                    .map(Chunk::content)
                    .toList();
            vectors.addAll(embed(batch));
        }

        jdbc.sql("delete from code_chunks where workspace_id = :workspaceId")
                .param("workspaceId", workspace.id())
                .update();
        for (int i = 0; i < chunks.size(); i++) {
            Chunk chunk = chunks.get(i);
            jdbc.sql("""
                            insert into code_chunks (workspace_id, file_path, start_line, end_line, content, embedding)
                            values (:workspaceId, :path, :startLine, :endLine, :content, :embedding)
                            """)
                    .param("workspaceId", workspace.id())
                    .param("path", chunk.path())
                    .param("startLine", chunk.startLine())
                    .param("endLine", chunk.endLine())
                    .param("content", chunk.content())
                    .param("embedding", writeJson(vectors.get(i)))
                    .update();
        }
        log.info("语义索引完成 workspace={} 块数={}", workspace.id(), chunks.size());
        return chunks.size();
    }

    /**
     * 语义检索：查询取向量 → 全量余弦 → top-K。
     */
    public SemanticHit.Result search(Workspace workspace, String query, Integer topK) {
        if (!available()) {
            return new SemanticHit.Result(SemanticHit.UNAVAILABLE,
                    "未配置 embedding 模型（LLM_EMBED_MODEL），语义检索不可用；正则 grep 仍可用。",
                    0, List.of());
        }
        int count = chunkCount(workspace.id());
        if (count == 0) {
            return new SemanticHit.Result(SemanticHit.NOT_INDEXED,
                    "该工作区还没有语义索引，先点「重建索引」。",
                    0, List.of());
        }

        float[] queryVector = embed(List.of(query)).get(0);
        int limit = topK == null || topK < 1 ? DEFAULT_TOP_K : Math.min(topK, 30);

        record Row(String path, int startLine, int endLine, String content, String embeddingJson) {
        }
        List<Row> rows = jdbc.sql("""
                        select file_path, start_line, end_line, content, embedding
                          from code_chunks
                         where workspace_id = :workspaceId
                        """)
                .param("workspaceId", workspace.id())
                .query((rs, rowNum) -> new Row(rs.getString(1), rs.getInt(2), rs.getInt(3),
                        rs.getString(4), rs.getString(5)))
                .list();

        List<SemanticHit> hits = rows.stream()
                .map(row -> new SemanticHit(row.path(), row.startLine(), row.endLine(), row.content(),
                        cosine(queryVector, parseVector(row.embeddingJson()))))
                .sorted((a, b) -> Double.compare(b.score(), a.score()))
                .limit(limit)
                .toList();
        return new SemanticHit.Result(SemanticHit.OK, "按余弦相似度排序。", count, hits);
    }

    // ------------------------------------------------------------ 切块

    private List<Chunk> chunkFile(String path, String text) {
        List<Chunk> chunks = new ArrayList<>();
        String[] lines = text.split("\n", -1);
        for (int from = 0; from < lines.length; from += CHUNK_LINES) {
            int to = Math.min(from + CHUNK_LINES, lines.length);
            StringBuilder block = new StringBuilder();
            for (int i = from; i < to; i++) {
                block.append(lines[i]).append('\n');
            }
            String content = block.toString().strip();
            if (content.isEmpty() || content.length() > MAX_CHUNK_CHARS) {
                continue;
            }
            chunks.add(new Chunk(path, from + 1, to, content));
        }
        return chunks;
    }

    private boolean isIgnoredPath(String relative) {
        String[] segments = relative.split("/");
        for (int i = 0; i < segments.length - 1; i++) {
            if (IgnoreRules.isIgnoredDirectory(segments[i])) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ embeddings API

    /** 调 OpenAI 兼容 /v1/embeddings，批量取向量。 */
    private List<float[]> embed(List<String> inputs) {
        String url = llmProperties.baseUrl().replaceAll("/+$", "") + "/embeddings";
        String body;
        try {
            body = objectMapper.writeValueAsString(Map.of(
                    "model", llmProperties.embeddingModel(),
                    "input", inputs));
        } catch (Exception ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "构造 embeddings 请求失败", ex);
        }
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + llmProperties.apiKey())
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "embeddings 请求失败: " + ex.getMessage(), ex);
        }
        if (response.statusCode() != 200) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR,
                    "embeddings 接口返回 " + response.statusCode() + ": " + abbreviate(response.body()));
        }
        try {
            JsonNode data = objectMapper.readTree(response.body()).path("data");
            List<float[]> vectors = new ArrayList<>(data.size());
            for (JsonNode item : data) {
                JsonNode array = item.path("embedding");
                float[] vector = new float[array.size()];
                for (int i = 0; i < array.size(); i++) {
                    vector[i] = (float) array.get(i).asDouble();
                }
                vectors.add(vector);
            }
            return vectors;
        } catch (Exception ex) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "解析 embeddings 响应失败", ex);
        }
    }

    // ------------------------------------------------------------ 向量

    private double cosine(float[] a, float[] b) {
        if (a == null || b == null || a.length != b.length) {
            return 0;
        }
        double dot = 0;
        double normA = 0;
        double normB = 0;
        for (int i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) {
            return 0;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private String writeJson(float[] vector) {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < vector.length; i++) {
            if (i > 0) {
                json.append(',');
            }
            json.append(vector[i]);
        }
        return json.append(']').toString();
    }

    private float[] parseVector(String json) {
        try {
            JsonNode array = objectMapper.readTree(json);
            float[] vector = new float[array.size()];
            for (int i = 0; i < array.size(); i++) {
                vector[i] = (float) array.get(i).asDouble();
            }
            return vector;
        } catch (Exception ex) {
            return null;
        }
    }

    private String abbreviate(String text) {
        if (text == null) {
            return "";
        }
        return text.length() > 300 ? text.substring(0, 300) + "…" : text;
    }
}
