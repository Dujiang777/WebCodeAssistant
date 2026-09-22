-- ============================================================================
-- 工作区快照（功能 9：应用补丁前自动打点 + 手动快照 + 一键回滚）
-- ============================================================================

-- 快照元数据。zip 实体存磁盘 data/snapshots/ws-{id}/{uuid}.zip，不进数据库。
create table snapshots
(
    id           uuid primary key default gen_random_uuid(),
    workspace_id bigint      not null references workspaces (id) on delete cascade,
    user_id      bigint      not null references users (id) on delete cascade,
    label        varchar(200),
    kind         varchar(16) not null default 'manual' check (kind in ('auto', 'manual')),
    patch_id     uuid references patches (id) on delete set null,
    file_count   int         not null default 0,
    size_bytes   bigint      not null default 0,
    created_at   timestamptz not null default now()
);

create index idx_snapshots_workspace on snapshots (workspace_id, created_at desc);
