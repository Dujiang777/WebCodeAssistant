-- ============================================================================
-- V6：多模型目录 · 自带密钥（BYOK）· 企业级用户管理
--
-- 这一版把「平台只跑一个写死的模型」改成「一份模型目录 + 用户可自带密钥」。
--
-- 三张新表各自解决一个具体问题：
--   llm_providers  模型服务商。分两级：scope=PLATFORM 是平台预置（用平台的 Key，
--                  消耗积分）；scope=USER 是用户自己添加的（自带 Key，不扣积分）。
--   llm_models     具体模型。单价挂在模型上而不是全局配置里 ——
--                  「贵模型多扣、便宜模型少扣」这句话只有这样才成立。
--   admin_audit    管理操作审计。管理员能停用账号、改角色、动别人的钱，
--                  这些动作必须留痕，而且是只增不改的痕。
--
-- 两条设计约束：
--   1. 平台级不把密钥存库 —— 只存「环境变量名」，运行时现取。
--      库被拖走时，平台自己的 Key 不会跟着泄漏。
--   2. 用户级密钥加密存库（AES-GCM，密钥来自 APP_SECRET），只回显尾号。
--      明文存 Key 等于「一次拖库 = 所有用户的所有模型账号」。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 模型服务商
--
-- owner_id 用生成列做唯一键的一部分，是因为 MySQL 的唯一索引**不约束多行 NULL**
-- （platform 行的 owner_id 全是 NULL，(scope, owner_id, code) 会允许插无数条重复）。
-- 生成列把它折成 0，唯一约束才真正生效。
--
-- 这里必须用 VIRTUAL 而不是 STORED：MySQL 明确禁止「基列上挂 ON DELETE CASCADE 的
-- 外键」与「基于该列的 STORED 生成列」共存（报 1215 Cannot add foreign key constraint）。
-- VIRTUAL 生成列一样能建二级索引（8.0 起），所以唯一键照常建立，只是不占存储。
-- ---------------------------------------------------------------------------
create table llm_providers
(
    id          bigint        not null auto_increment,
    scope       varchar(16)   not null comment 'PLATFORM（平台预置）/ USER（用户自带）',
    owner_id    bigint        null comment 'scope=USER 时指向 users.id；platform 行为 NULL',
    code        varchar(48)   not null comment '稳定标识，如 deepseek / openai / custom-1',
    name        varchar(80)   not null comment '显示名，如「DeepSeek 官方」',
    base_url    varchar(255)  not null comment 'OpenAI 兼容端点，如 https://api.deepseek.com/v1',
    api_key_env varchar(64)   null comment 'scope=PLATFORM：密钥所在的环境变量名，不存明文',
    api_key_enc varchar(1024) null comment 'scope=USER：AES-GCM 加密后的密钥',
    api_key_hint varchar(32)  null comment '只回显尾号，如 ****a1b2；前端永远拿不到完整密钥',
    homepage    varchar(255)  null comment '申请 Key 的地址，界面上给用户一个跳转',
    enabled     tinyint(1)    not null default 1,
    sort_order  int           not null default 0,
    created_at  datetime(6)   not null default current_timestamp(6),
    updated_at  datetime(6)   not null default current_timestamp(6)
        on update current_timestamp(6),
    owner_key   bigint generated always as (ifnull(owner_id, 0)) virtual,
    primary key (id),
    unique key uk_llm_providers_scope_code (scope, owner_key, code),
    key idx_llm_providers_owner (owner_id, sort_order),
    constraint fk_llm_providers_owner foreign key (owner_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 模型
--
-- 单价就是「每 1000 token 扣多少积分」，输入输出分开：
-- 一轮对话里输入常常是输出的几十倍（整个文件 + 历史 + 工具结果都算输入），
-- 同一个单价会让「把整个仓库贴进 prompt」几乎免费 —— 那正是最烧钱的用法。
--
-- tier 只用于界面分组与默认推荐，不参与计算；真正的钱由两个单价决定，
-- 避免出现「改了 tier 忘了改价」这种两处真相。
-- ---------------------------------------------------------------------------
create table llm_models
(
    id                   bigint       not null auto_increment,
    provider_id          bigint       not null,
    model_key            varchar(96)  not null comment '请求里传给模型服务的 model 名',
    display_name         varchar(96)  not null,
    tier                 varchar(16)  not null default 'STANDARD' comment 'LIGHT / STANDARD / FLAGSHIP',
    credits_per_1k_input bigint       not null default 0,
    credits_per_1k_output bigint      not null default 0,
    context_window       int          null comment '上下文窗口（token），仅用于界面提示',
    supports_tools       tinyint(1)   not null default 1 comment '不支持工具调用的模型不能用于改代码',
    note                 varchar(200) null,
    enabled              tinyint(1)   not null default 1,
    sort_order           int          not null default 0,
    created_at           datetime(6)  not null default current_timestamp(6),
    updated_at           datetime(6)  not null default current_timestamp(6)
        on update current_timestamp(6),
    primary key (id),
    unique key uk_llm_models_provider_key (provider_id, model_key),
    key idx_llm_models_provider (provider_id, sort_order),
    constraint fk_llm_models_provider foreign key (provider_id) references llm_providers (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 管理操作审计
--
-- 与 login_audit 分开：那张表记「谁在登录」，这张表记「管理员对别人做了什么」。
-- operator_name 冗余存一份 —— 用户改名或注销后，审计仍然要能读懂。
-- detail 存人话（「+500 分：补偿昨天故障」），不存 JSON 结构，
-- 因为读它的人以后是运维而不是程序。
-- ---------------------------------------------------------------------------
create table admin_audit
(
    id            bigint       not null auto_increment,
    operator_id   bigint       not null,
    operator_name varchar(64)  not null,
    action        varchar(48)  not null comment 'USER_DISABLE / USER_ENABLE / USER_UNLOCK / ROLE_CHANGE / ADMIN_RESET_PASSWORD / REVOKE_SESSIONS / CREDIT_ADJUST / ORDER_CANCEL / RECONCILE',
    target_type   varchar(24)  not null comment 'USER / ORDER',
    target_id     varchar(64)  null,
    target_name   varchar(120) null,
    detail        varchar(500) null,
    ip            varchar(64)  null,
    created_at    datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_admin_audit_operator (operator_id, created_at),
    key idx_admin_audit_target (target_type, target_id, created_at),
    key idx_admin_audit_time (created_at)
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- users 扩列：停用原因与管理端检索索引
--
-- 为什么停用要记原因与操作人：客服最常见的对话是「我账号怎么不能用了」，
-- 答不上来就只能再问一遍技术人员。有了这三列，问题当场能答。
-- ---------------------------------------------------------------------------
alter table users
    add column disabled_reason   varchar(200) null after status,
    add column disabled_at       datetime(6)  null after disabled_reason,
    add column disabled_by       bigint       null after disabled_at,
    -- 注意 MySQL 的列定义顺序：COMMENT 必须写在 AFTER 之前，
    -- 反过来（after x comment 'y'）会报 1064 语法错误 —— 这里踩过一次。
    add column default_model_key varchar(96)  null comment '用户选定的默认模型；为空则跟随平台默认' after disabled_by,
    -- 会话世代：改密 / 重置密码 / 强制下线 / 停用时 +1。
    -- access token 是无状态的，光吊销 refresh 只能让人「下次刷新进不来」，
    -- 手上那张还在有效期内（2 小时）的令牌依然畅通 —— 有了这一列，
    -- 令牌里带上签发时的世代号，比对不上就立刻作废，这类操作才能真正「马上生效」。
    add column token_epoch     bigint       not null default 0 comment '会话世代，见 JwtService' after default_model_key,
    add key idx_users_created (created_at),
    add key idx_users_role (role, created_at),
    add key idx_users_status (status, created_at);

-- ---------------------------------------------------------------------------
-- 会话记下本轮用的模型
--
-- 记在会话上而不是只记在消息 meta 里：用户下次打开这个会话时，
-- 选择器要能直接回显「上次用的是哪个模型」，而不是让用户重新挑一遍。
-- ---------------------------------------------------------------------------
alter table chat_sessions
    add column model_key varchar(96) null after title;

-- ============================================================================
-- 平台预置模型目录
--
-- 定价口径：一轮典型对话 ≈ 12k 输入 + 1k 输出 token。
--   LIGHT     ≈ 15 分/轮   —— 日常问答、解释代码
--   STANDARD  ≈ 30 分/轮   —— 改代码的主力档
--   FLAGSHIP  ≈ 90 分/轮   —— 复杂重构，或者就是想要最好效果
-- 这样「体验包 1000 分」约等于 33 轮标准档对话，与套餐文案能对上。
--
-- 平台 Key 全部通过环境变量注入，库里不存任何明文：
--   优先读各 provider 自己的变量名，没配则回退到全局 LLM_API_KEY。
--   所以本地自检只设 LLM_API_KEY=mock 就能把 mock 那档跑起来。
-- ============================================================================
insert into llm_providers (scope, owner_id, code, name, base_url, api_key_env, homepage, sort_order)
values ('PLATFORM', null, 'deepseek', 'DeepSeek 官方', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', 'https://platform.deepseek.com/api_keys', 10),
       ('PLATFORM', null, 'openai', 'OpenAI', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'https://platform.openai.com/api-keys', 20),
       ('PLATFORM', null, 'dashscope', '阿里云通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 'https://bailian.console.aliyun.com/', 30),
       ('PLATFORM', null, 'zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'ZHIPU_API_KEY', 'https://open.bigmodel.cn/usercenter/apikeys', 40),
       ('PLATFORM', null, 'moonshot', '月之暗面 Kimi', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY', 'https://platform.moonshot.cn/console/api-keys', 50),
       ('PLATFORM', null, 'mock', '本地模拟模型', 'http://127.0.0.1:8787/v1', 'MOCK_API_KEY', null, 900);

insert into llm_models (provider_id, model_key, display_name, tier, credits_per_1k_input, credits_per_1k_output,
                        context_window, supports_tools, note, sort_order)
select p.id, m.model_key, m.display_name, m.tier, m.cin, m.cout, m.ctx, m.tools, m.note, m.ord
from llm_providers p
         join (select 'deepseek' provider, 'deepseek-flash' model_key, 'DeepSeek 快速版' display_name, 'LIGHT' tier, 1 cin, 3 cout, 128000 ctx, 1 tools, '快、便宜，日常问答与解释代码首选' note, 10 ord
               union all
               select 'deepseek', 'deepseek-chat', 'DeepSeek 对话版', 'STANDARD', 2, 6, 128000, 1, '改代码的主力档，速度与质量平衡', 20
               union all
               select 'deepseek', 'deepseek-reasoner', 'DeepSeek 推理版', 'FLAGSHIP', 6, 18, 128000, 1, '复杂重构与疑难排查，慢但更准', 30
               union all
               select 'openai', 'gpt-4o-mini', 'GPT-4o mini', 'LIGHT', 2, 6, 128000, 1, 'OpenAI 家的轻量档', 10
               union all
               select 'openai', 'gpt-4o', 'GPT-4o', 'FLAGSHIP', 12, 36, 128000, 1, '综合能力最强，积分消耗也最高', 20
               union all
               select 'dashscope', 'qwen-plus', '通义千问 Plus', 'STANDARD', 2, 6, 131072, 1, '中文语境好，价格适中', 10
               union all
               select 'dashscope', 'qwen-max', '通义千问 Max', 'FLAGSHIP', 8, 24, 32768, 1, '通义旗舰，长文理解强', 20
               union all
               select 'zhipu', 'glm-4-flash', '智谱 GLM-4 Flash', 'LIGHT', 1, 2, 128000, 1, '免费档位，适合高频轻量使用', 10
               union all
               select 'zhipu', 'glm-4-plus', '智谱 GLM-4 Plus', 'STANDARD', 4, 12, 128000, 1, '智谱主力档', 20
               union all
               select 'moonshot', 'moonshot-v1-8k', 'Kimi 8K', 'STANDARD', 3, 9, 8192, 1, '长文本阅读能力突出', 10
               union all
               select 'mock', 'mock-coder', '本地模拟模型', 'LIGHT', 1, 3, 32000, 1, '离线自检专用，不消耗真实额度', 10) m
              on m.provider = p.code
where p.scope = 'PLATFORM';
