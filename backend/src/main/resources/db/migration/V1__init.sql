-- ============================================================================
-- Web Code Assistant 初始表结构
-- PostgreSQL 16
-- ============================================================================

create table users
(
    id            bigserial primary key,
    username      varchar(64)  not null unique,
    password_hash varchar(100) not null,
    created_at    timestamptz  not null default now()
);

-- 工作区：服务器磁盘上的一个目录，用户之间以 user_id 隔离
create table workspaces
(
    id         bigserial primary key,
    user_id    bigint       not null references users (id) on delete cascade,
    name       varchar(128) not null,
    root_path  text         not null,
    git_url    text,
    size_bytes bigint       not null default 0,
    created_at timestamptz  not null default now()
);

create index idx_workspaces_user on workspaces (user_id);

-- 会话
create table chat_sessions
(
    id           bigserial primary key,
    workspace_id bigint       not null references workspaces (id) on delete cascade,
    user_id      bigint       not null references users (id) on delete cascade,
    title        varchar(200) not null,
    created_at   timestamptz  not null default now(),
    updated_at   timestamptz  not null default now()
);

create index idx_chat_sessions_workspace on chat_sessions (workspace_id);
create index idx_chat_sessions_user on chat_sessions (user_id, updated_at desc);

-- 消息。content 存正文；meta 存工具调用轨迹、token 用量、引用文件等结构化信息。
create table chat_messages
(
    id         bigserial primary key,
    session_id bigint      not null references chat_sessions (id) on delete cascade,
    role       varchar(16) not null check (role in ('user', 'assistant', 'system', 'tool')),
    content    text        not null,
    meta       jsonb,
    created_at timestamptz not null default now()
);

create index idx_chat_messages_session on chat_messages (session_id, id);

-- 补丁。id 用 uuid：既是 SSE 事件里对外的标识，也避免被枚举出别人的补丁。
create table patches
(
    id         uuid primary key     default gen_random_uuid(),
    session_id bigint      not null references chat_sessions (id) on delete cascade,
    message_id bigint references chat_messages (id) on delete set null,
    file_path  text        not null,
    diff_text  text        not null,
    status     varchar(16) not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
    created_at timestamptz not null default now(),
    applied_at timestamptz
);

create index idx_patches_session on patches (session_id, id);
create index idx_patches_pending on patches (session_id) where status = 'pending';
