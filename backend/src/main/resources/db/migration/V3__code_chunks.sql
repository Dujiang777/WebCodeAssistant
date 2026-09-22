-- ============================================================================
-- 语义检索：代码块向量（功能 11）
-- 存 jsonb 而不是上 pgvector：向量检索在 Java 侧做（工作区规模 ≤ 数千块，
-- 全量余弦是毫秒级），不要求用户给 PG 装扩展 —— 开箱即用优先。
-- ============================================================================

create table code_chunks
(
    id           bigserial primary key,
    workspace_id bigint      not null references workspaces (id) on delete cascade,
    file_path    text        not null,
    start_line   int         not null,
    end_line     int         not null,
    content      text        not null,
    embedding    jsonb       not null,
    created_at   timestamptz not null default now()
);

create index idx_code_chunks_workspace on code_chunks (workspace_id);
