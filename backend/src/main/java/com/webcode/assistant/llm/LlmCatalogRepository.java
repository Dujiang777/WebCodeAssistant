package com.webcode.assistant.llm;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;

/**
 * 模型目录访问：{@code llm_providers} + {@code llm_models}。
 *
 * <p>两张表放一个仓储里，是因为它们的查询几乎总是成对出现
 * （「取模型」必然要连带取它的 provider 才知道地址和密钥）。
 * 拆成两个类只会让每个调用点都得写两次 join。
 *
 * <p>可见性规则贯穿所有查询，只有两条：
 * <ul>
 *   <li>平台行（{@code scope='PLATFORM'}）人人可见；</li>
 *   <li>用户行（{@code owner_id=?}）只有本人可见。</li>
 * </ul>
 * 没有任何「按 id 取出再判断归属」的写法 —— 归属直接写进 where，
 * 免得某处忘了判断就变成越权。
 *
 * <p><b>联合查询的列必须显式别名</b>（{@code m_*} / {@code p_*}）：
 * 两张表都有 {@code id} / {@code name} / {@code enabled} / {@code sort_order}，
 * 不别名的话 {@code rs.getLong("id")} 只会拿到结果集里的第一个，
 * provider 会被赋成模型的 id —— 这种错误不会报异常，只会让缓存键与归属全错。
 */
@Repository
public class LlmCatalogRepository {

    public static final String SCOPE_PLATFORM = "PLATFORM";
    public static final String SCOPE_USER = "USER";

    /** 服务商（密钥只以加密串存在，明文永远不进这个对象）。 */
    public record Provider(
            long id,
            String scope,
            Long ownerId,
            String code,
            String name,
            String baseUrl,
            String apiKeyEnv,
            String apiKeyEnc,
            String apiKeyHint,
            String homepage,
            boolean enabled,
            int sortOrder
    ) {
        public boolean platform() {
            return SCOPE_PLATFORM.equals(scope);
        }
    }

    /** 模型（纯元数据，不含 provider 信息）。 */
    public record Model(
            long id,
            long providerId,
            String modelKey,
            String displayName,
            String tier,
            long per1kInput,
            long per1kOutput,
            Integer contextWindow,
            boolean supportsTools,
            String note,
            boolean enabled,
            int sortOrder
    ) {
    }

    /** 模型 + 所属服务商的联合行，解析与列表都用它。 */
    public record ModelRow(Model model, Provider provider) {
    }

    private static final String PROVIDER_COLUMNS =
            "id, scope, owner_id, code, name, base_url, api_key_env, api_key_enc, api_key_hint, "
                    + "homepage, enabled, sort_order";

    private static final String MODEL_COLUMNS =
            "id, provider_id, model_key, display_name, tier, credits_per_1k_input, credits_per_1k_output, "
                    + "context_window, supports_tools, note, enabled, sort_order";

    /** 联合查询用：两组列都加前缀，避免重名。 */
    private static final String JOIN_COLUMNS =
            "m.id as m_id, m.provider_id as m_provider_id, m.model_key as m_model_key, "
                    + "m.display_name as m_display_name, m.tier as m_tier, "
                    + "m.credits_per_1k_input as m_per1k_in, m.credits_per_1k_output as m_per1k_out, "
                    + "m.context_window as m_ctx, m.supports_tools as m_tools, m.note as m_note, "
                    + "m.enabled as m_enabled, m.sort_order as m_sort_order, "
                    + "p.id as p_id, p.scope as p_scope, p.owner_id as p_owner, p.code as p_code, "
                    + "p.name as p_name, p.base_url as p_base_url, p.api_key_env as p_env, "
                    + "p.api_key_enc as p_enc, p.api_key_hint as p_hint, p.homepage as p_home, "
                    + "p.enabled as p_enabled, p.sort_order as p_sort_order";

    private static final String FROM_JOIN =
            " from llm_models m join llm_providers p on p.id = m.provider_id ";

    private final JdbcClient jdbc;

    public LlmCatalogRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------ 服务商

    /** 某人能看见的全部服务商：平台预置 + 自己添加的。 */
    public List<Provider> listVisibleProviders(long userId) {
        return jdbc.sql("select " + PROVIDER_COLUMNS + " from llm_providers "
                        + "where scope = 'PLATFORM' or owner_id = :uid "
                        + "order by scope desc, sort_order, id")
                .param("uid", userId)
                .query(LlmCatalogRepository::mapProvider)
                .list();
    }

    public Optional<Provider> findProvider(long id) {
        return jdbc.sql("select " + PROVIDER_COLUMNS + " from llm_providers where id = :id")
                .param("id", id)
                .query(LlmCatalogRepository::mapProvider)
                .optional();
    }

    /** 按 code 找平台服务商。 */
    public Optional<Provider> findPlatformProvider(String code) {
        return jdbc.sql("select " + PROVIDER_COLUMNS + " from llm_providers "
                        + "where scope = 'PLATFORM' and code = :c")
                .param("c", code)
                .query(LlmCatalogRepository::mapProvider)
                .optional();
    }

    /** 用户自己的服务商，带归属校验。查不到 = 不存在或不是他的，调用方无需再区分。 */
    public Optional<Provider> findOwnProvider(long id, long userId) {
        return jdbc.sql("select " + PROVIDER_COLUMNS + " from llm_providers "
                        + "where id = :id and owner_id = :uid")
                .param("id", id)
                .param("uid", userId)
                .query(LlmCatalogRepository::mapProvider)
                .optional();
    }

    public long insertUserProvider(long userId, String code, String name, String baseUrl,
                                   String apiKeyEnc, String apiKeyHint, String homepage) {
        jdbc.sql("insert into llm_providers (scope, owner_id, code, name, base_url, api_key_enc, "
                        + "api_key_hint, homepage, sort_order) "
                        + "values ('USER', :uid, :code, :name, :url, :enc, :hint, :home, "
                        + "coalesce((select max(p2.sort_order) + 10 from llm_providers p2 where p2.owner_id = :uid), 10))")
                .param("uid", userId)
                .param("code", code)
                .param("name", name)
                .param("url", baseUrl)
                .param("enc", apiKeyEnc)
                .param("hint", apiKeyHint)
                .param("home", homepage)
                .update();
        return jdbc.sql("select " + PROVIDER_COLUMNS + " from llm_providers where owner_id = :uid and code = :c")
                .param("uid", userId)
                .param("c", code)
                .query(LlmCatalogRepository::mapProvider)
                .single()
                .id();
    }

    /**
     * 更新用户自己的服务商。
     *
     * <p>{@code apiKeyEnc} 传 null 表示<b>不改密钥</b>（用户只改了名字）。
     * 界面上密钥永远只回显尾号，所以「留空 = 保持原样」是唯一可行的表达。
     */
    public int updateUserProvider(long id, long userId, String name, String baseUrl,
                                  String apiKeyEnc, String apiKeyHint, String homepage, boolean enabled) {
        return jdbc.sql("update llm_providers set name = :name, base_url = :url, "
                        + "api_key_enc = coalesce(:enc, api_key_enc), "
                        + "api_key_hint = coalesce(:hint, api_key_hint), "
                        + "homepage = :home, enabled = :en "
                        + "where id = :id and owner_id = :uid")
                .param("name", name)
                .param("url", baseUrl)
                .param("enc", apiKeyEnc)
                .param("hint", apiKeyHint)
                .param("home", homepage)
                .param("en", enabled)
                .param("id", id)
                .param("uid", userId)
                .update();
    }

    public int deleteUserProvider(long id, long userId) {
        return jdbc.sql("delete from llm_providers where id = :id and owner_id = :uid")
                .param("id", id)
                .param("uid", userId)
                .update();
    }

    public int countUserProviders(long userId) {
        return jdbc.sql("select count(*) from llm_providers where owner_id = :uid")
                .param("uid", userId)
                .query(Integer.class)
                .single();
    }

    // ------------------------------------------------------------ 模型

    public List<ModelRow> listVisibleModels(long userId) {
        return jdbc.sql("select " + JOIN_COLUMNS + FROM_JOIN
                        + "where (p.scope = 'PLATFORM' or p.owner_id = :uid) "
                        + "and m.enabled = 1 and p.enabled = 1 "
                        + "order by p.scope desc, p.sort_order, m.sort_order, m.id")
                .param("uid", userId)
                .query(LlmCatalogRepository::mapRow)
                .list();
    }

    /** 目录里全部平台模型（含停用），供自检与管理端核对。 */
    public List<ModelRow> listAllPlatformModels() {
        return jdbc.sql("select " + JOIN_COLUMNS + FROM_JOIN
                        + "where p.scope = 'PLATFORM' order by p.sort_order, m.sort_order")
                .query(LlmCatalogRepository::mapRow)
                .list();
    }

    /**
     * 按 model_key 解析模型。
     *
     * <p>同名 key 同时存在于平台与用户自带时，<b>优先用户自己的</b>
     * —— 用户费劲填了自己的 Key，就是不想走平台的计费通道。
     */
    public Optional<ModelRow> findVisibleModelByKey(long userId, String modelKey) {
        return jdbc.sql("select " + JOIN_COLUMNS + FROM_JOIN
                        + "where m.model_key = :key and m.enabled = 1 and p.enabled = 1 "
                        + "and (p.scope = 'PLATFORM' or p.owner_id = :uid) "
                        + "order by (p.owner_id is not null) desc, p.sort_order, m.sort_order limit 1")
                .param("key", modelKey)
                .param("uid", userId)
                .query(LlmCatalogRepository::mapRow)
                .optional();
    }

    public Optional<ModelRow> findModel(long id) {
        return jdbc.sql("select " + JOIN_COLUMNS + FROM_JOIN + "where m.id = :id")
                .param("id", id)
                .query(LlmCatalogRepository::mapRow)
                .optional();
    }

    public List<Model> listUserModels(long providerId) {
        return jdbc.sql("select " + MODEL_COLUMNS + " from llm_models where provider_id = :pid "
                        + "order by sort_order, id")
                .param("pid", providerId)
                .query(LlmCatalogRepository::mapModel)
                .list();
    }

    public long insertUserModel(long providerId, String modelKey, String displayName, String tier,
                                boolean supportsTools, Integer contextWindow, String note) {
        jdbc.sql("insert into llm_models (provider_id, model_key, display_name, tier, "
                        + "credits_per_1k_input, credits_per_1k_output, context_window, supports_tools, note, sort_order) "
                        + "values (:pid, :key, :name, :tier, 0, 0, :ctx, :tools, :note, "
                        + "coalesce((select max(m2.sort_order) + 10 from llm_models m2 where m2.provider_id = :pid), 10))")
                .param("pid", providerId)
                .param("key", modelKey)
                .param("name", displayName)
                .param("tier", tier)
                .param("ctx", contextWindow)
                .param("tools", supportsTools)
                .param("note", note)
                .update();
        return jdbc.sql("select " + MODEL_COLUMNS + " from llm_models where provider_id = :pid and model_key = :k")
                .param("pid", providerId)
                .param("k", modelKey)
                .query(LlmCatalogRepository::mapModel)
                .single()
                .id();
    }

    // ------------------------------------------------------------ 映射

    private static Provider mapProvider(ResultSet rs, int rowNum) throws SQLException {
        return new Provider(
                rs.getLong("id"),
                rs.getString("scope"),
                nullableLong(rs, "owner_id"),
                rs.getString("code"),
                rs.getString("name"),
                rs.getString("base_url"),
                rs.getString("api_key_env"),
                rs.getString("api_key_enc"),
                rs.getString("api_key_hint"),
                rs.getString("homepage"),
                rs.getBoolean("enabled"),
                rs.getInt("sort_order"));
    }

    private static Model mapModel(ResultSet rs, int rowNum) throws SQLException {
        return new Model(
                rs.getLong("id"),
                rs.getLong("provider_id"),
                rs.getString("model_key"),
                rs.getString("display_name"),
                rs.getString("tier"),
                rs.getLong("credits_per_1k_input"),
                rs.getLong("credits_per_1k_output"),
                (Integer) rs.getObject("context_window"),
                rs.getBoolean("supports_tools"),
                rs.getString("note"),
                rs.getBoolean("enabled"),
                rs.getInt("sort_order"));
    }

    private static ModelRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        Model model = new Model(
                rs.getLong("m_id"),
                rs.getLong("m_provider_id"),
                rs.getString("m_model_key"),
                rs.getString("m_display_name"),
                rs.getString("m_tier"),
                rs.getLong("m_per1k_in"),
                rs.getLong("m_per1k_out"),
                (Integer) rs.getObject("m_ctx"),
                rs.getBoolean("m_tools"),
                rs.getString("m_note"),
                rs.getBoolean("m_enabled"),
                rs.getInt("m_sort_order"));
        Provider provider = new Provider(
                rs.getLong("p_id"),
                rs.getString("p_scope"),
                nullableLong(rs, "p_owner"),
                rs.getString("p_code"),
                rs.getString("p_name"),
                rs.getString("p_base_url"),
                rs.getString("p_env"),
                rs.getString("p_enc"),
                rs.getString("p_hint"),
                rs.getString("p_home"),
                rs.getBoolean("p_enabled"),
                rs.getInt("p_sort_order"));
        return new ModelRow(model, provider);
    }

    private static Long nullableLong(ResultSet rs, String column) throws SQLException {
        long value = rs.getLong(column);
        return rs.wasNull() ? null : value;
    }
}
