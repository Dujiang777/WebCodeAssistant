-- ============================================================================
-- Web Code Assistant 初始表结构
-- MySQL 8.0（要求 8.0.13+：check 约束与表达式默认值）
--
-- 从 PostgreSQL 迁移过来时踩过的四个坑，都写在列定义旁边：
--   bigserial   → bigint auto_increment
--   timestamptz → datetime(6)（配合连接串固定会话时区，保证瞬时值闭环）
--   jsonb       → json
--   uuid        → char(36)
-- ============================================================================

create table users
(
    id            bigint       not null auto_increment,
    username      varchar(64)  not null,
    password_hash varchar(100) not null,
    created_at    datetime(6)  not null default current_timestamp(6),
    primary key (id),
    unique key uk_users_username (username)
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- 工作区：服务器磁盘上的一个目录，用户之间以 user_id 隔离
create table workspaces
(
    id         bigint       not null auto_increment,
    user_id    bigint       not null,
    name       varchar(128) not null,
    root_path  text         not null,
    git_url    text         null,
    size_bytes bigint       not null default 0,
    created_at datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_workspaces_user (user_id),
    constraint fk_workspaces_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- 会话
create table chat_sessions
(
    id           bigint       not null auto_increment,
    workspace_id bigint       not null,
    user_id      bigint       not null,
    title        varchar(200) not null,
    created_at   datetime(6)  not null default current_timestamp(6),
    updated_at   datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_chat_sessions_workspace (workspace_id),
    key idx_chat_sessions_user (user_id, updated_at desc),
    constraint fk_chat_sessions_workspace foreign key (workspace_id) references workspaces (id) on delete cascade,
    constraint fk_chat_sessions_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- 消息。content 存正文；meta 存工具调用轨迹、token 用量、引用文件等结构化信息。
-- meta 用 json 而非 longtext：让「写进去的必须是合法 JSON」由数据库兜底。
create table chat_messages
(
    id         bigint      not null auto_increment,
    session_id bigint      not null,
    role       varchar(16) not null,
    content    text        not null,
    meta       json        null,
    created_at datetime(6) not null default current_timestamp(6),
    primary key (id),
    key idx_chat_messages_session (session_id, id),
    constraint fk_chat_messages_session foreign key (session_id) references chat_sessions (id) on delete cascade,
    constraint ck_chat_messages_role check (role in ('user', 'assistant', 'system', 'tool'))
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- 补丁。id 用 uuid（char(36)）：既是 SSE 事件里对外的标识，也避免被枚举出别人的补丁。
-- 主键由 Java 侧生成后显式写入 —— MySQL 的 getGeneratedKeys() 只保证返回自增列，
-- 指望它取回「由数据库默认值生成的」非自增主键是不可靠的。
create table patches
(
    id         char(36)    not null,
    session_id bigint      not null,
    message_id bigint      null,
    file_path  text        not null,
    diff_text  text        not null,
    status     varchar(16) not null default 'pending',
    created_at datetime(6) not null default current_timestamp(6),
    applied_at datetime(6) null,
    primary key (id),
    key idx_patches_session (session_id, id),
    -- PostgreSQL 用部分索引 where status = 'pending'；MySQL 没有部分索引，
    -- 退化成 (session_id, status) 复合索引 —— 前缀 session_id 仍能被单独命中。
    key idx_patches_pending (session_id, status),
    constraint fk_patches_session foreign key (session_id) references chat_sessions (id) on delete cascade,
    constraint fk_patches_message foreign key (message_id) references chat_messages (id) on delete set null,
    constraint ck_patches_status check (status in ('pending', 'applied', 'rejected'))
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
