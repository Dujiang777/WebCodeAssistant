-- ============================================================================
-- 工作区快照（功能 9：应用补丁前自动打点 + 手动快照 + 一键回滚）
-- ============================================================================

-- 快照元数据。zip 实体存磁盘 data/snapshots/ws-{id}/{uuid}.zip，不进数据库。
-- id 由 Java 侧生成（zip 文件名与 DB 行必须同 id，否则回滚时找不到文件）。
create table snapshots
(
    id           char(36)     not null,
    workspace_id bigint       not null,
    user_id      bigint       not null,
    label        varchar(200) null,
    kind         varchar(16)  not null default 'manual',
    patch_id     char(36)     null,
    file_count   int          not null default 0,
    size_bytes   bigint       not null default 0,
    created_at   datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_snapshots_workspace (workspace_id, created_at desc),
    constraint fk_snapshots_workspace foreign key (workspace_id) references workspaces (id) on delete cascade,
    constraint fk_snapshots_user foreign key (user_id) references users (id) on delete cascade,
    constraint fk_snapshots_patch foreign key (patch_id) references patches (id) on delete set null,
    constraint ck_snapshots_kind check (kind in ('auto', 'manual'))
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
