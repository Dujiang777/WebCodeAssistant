-- ============================================================================
-- V4：账号体系商业化改造
--
-- 目标：把「用户名 + 密码 + 一次性 JWT」升级成能上线的账号系统。
-- 新增的每一列/每张表都对应一个具体的线上问题，写在注释里。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users 扩列
--
-- 三个「不这么做就会出线上事故」的点：
--   1. email 允许为 null —— 存量账号（以及演示账号）没有邮箱，加 not null 会直接迁移失败；
--      MySQL 的唯一索引对多行 NULL 不判定冲突，所以 uk_users_email 可以放心加。
--   2. failed_attempts + locked_until —— 没有它，密码可以无限次撞，等于没有密码。
--   3. role —— 积分管理端要鉴权，先立住角色，别等有了管理员功能再回头改表。
-- ---------------------------------------------------------------------------
alter table users
    add column email           varchar(160) null after username,
    add column email_verified  tinyint(1)   not null default 0 after email,
    add column role            varchar(16)  not null default 'USER' after password_hash,
    add column status          varchar(16)  not null default 'ACTIVE' after role,
    add column failed_attempts int          not null default 0 after status,
    add column locked_until    datetime(6)  null after failed_attempts,
    add column last_login_at   datetime(6)  null after locked_until,
    add column updated_at      datetime(6)  not null default current_timestamp(6)
        on update current_timestamp(6) after last_login_at,
    add unique key uk_users_email (email);

-- ---------------------------------------------------------------------------
-- 邮件令牌：邮箱验证 + 重置密码共用一张表
--
-- 只存 sha256 十六进制摘要，不存明文 —— 库被拖走也不能拿去直接改别人的密码。
-- consumed_at 而不是删行：改完密码还能回答「这个链接什么时候用过的」。
-- ---------------------------------------------------------------------------
create table email_tokens
(
    id          bigint      not null auto_increment,
    user_id     bigint      not null,
    token_hash  char(64)    not null,
    purpose     varchar(24) not null comment 'VERIFY_EMAIL / RESET_PASSWORD',
    expires_at  datetime(6) not null,
    consumed_at datetime(6) null,
    created_at  datetime(6) not null default current_timestamp(6),
    primary key (id),
    unique key uk_email_tokens_hash (token_hash),
    key idx_email_tokens_user (user_id, purpose, created_at),
    constraint fk_email_tokens_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 刷新令牌
--
-- 为什么必须有：access token 只有 2 小时，没有 refresh 就得两小时登一次；
-- 把 access 拉长到 30 天，又等于「令牌泄露 = 30 天不可撤销」。
--
-- replaced_by：轮换链。每次刷新旧令牌吊销并记下被谁替代，
-- 若同一个旧令牌被第二次使用（重放），可以顺着链把整条会话全部吊销。
-- ---------------------------------------------------------------------------
create table refresh_tokens
(
    id          bigint      not null auto_increment,
    user_id     bigint      not null,
    token_hash  char(64)    not null,
    device      varchar(120) null comment 'User-Agent 摘要，用于「登录设备」列表',
    ip          varchar(64)  null,
    expires_at  datetime(6) not null,
    revoked_at  datetime(6) null,
    replaced_by char(64)    null,
    created_at  datetime(6) not null default current_timestamp(6),
    primary key (id),
    unique key uk_refresh_tokens_hash (token_hash),
    key idx_refresh_tokens_user (user_id, created_at),
    constraint fk_refresh_tokens_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 登录审计
--
-- user_id 允许 null：撞库尝试的用户名可能根本不存在，
-- 但「有人拿这批用户名在撞」这件事必须留痕。
-- ---------------------------------------------------------------------------
create table login_audit
(
    id         bigint       not null auto_increment,
    user_id    bigint       null,
    username   varchar(64)  not null,
    success    tinyint(1)   not null,
    reason     varchar(64)  null,
    ip         varchar(64)  null,
    user_agent varchar(255) null,
    created_at datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_login_audit_user (user_id, created_at),
    key idx_login_audit_time (created_at)
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
