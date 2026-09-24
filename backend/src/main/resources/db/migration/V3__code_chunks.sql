-- ============================================================================
-- 语义检索：代码块向量（功能 11）
-- 存 json 而不是上向量索引：向量检索在 Java 侧做（工作区规模 ≤ 数千块，
-- 全量余弦是毫秒级），不要求用户给数据库装任何扩展 —— 开箱即用优先。
-- ============================================================================

create table code_chunks
(
    id           bigint      not null auto_increment,
    workspace_id bigint      not null,
    file_path    text        not null,
    start_line   int         not null,
    end_line     int         not null,
    content      text        not null,
    -- MySQL 的 json 是独立的二进制存储类型，不受 TEXT 的 64KB 行内上限约束，
    -- 1536 维 float 序列化成 JSON 约 30KB，放得下。
    embedding    json        not null,
    created_at   datetime(6) not null default current_timestamp(6),
    primary key (id),
    key idx_code_chunks_workspace (workspace_id),
    constraint fk_code_chunks_workspace foreign key (workspace_id) references workspaces (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
