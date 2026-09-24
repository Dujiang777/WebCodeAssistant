-- ============================================================================
-- V5：AI 用量积分体系
--
-- 计费模型（就三层，不搞复杂）：
--   credit_accounts  当前余额，读得多写得少，是「快照」
--   credit_ledger    每一次变动，只增不改，是「事实」；余额永远可以由它重算出来
--   credit_plans / credit_orders  怎么把人民币变成积分
--
-- 两个关键设计：
--   1. 余额用原子 SQL 扣（update ... where balance >= ?），不用「读-判断-写」——
--      后者在同一用户并发两轮对话时必然会扣成负数。
--   2. 幂等键唯一索引：支付回调会重试，对话会重跑，同一笔业务只能入账一次。
--      MySQL 唯一索引对多行 NULL 不冲突，所以「不需要幂等的记账」留 NULL 即可。
-- ============================================================================

create table credit_accounts
(
    user_id        bigint      not null,
    balance        bigint      not null default 0,
    total_granted  bigint      not null default 0,
    total_consumed bigint      not null default 0,
    created_at     datetime(6) not null default current_timestamp(6),
    updated_at     datetime(6) not null default current_timestamp(6)
        on update current_timestamp(6),
    primary key (user_id),
    constraint fk_credit_accounts_user foreign key (user_id) references users (id) on delete cascade,
    -- 兜底防线：即使业务代码算错了，余额也不可能是负的（MySQL 8.0.16+ 才真正强制执行）
    constraint ck_credit_accounts_balance check (balance >= 0)
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

create table credit_ledger
(
    id              bigint       not null auto_increment,
    user_id         bigint       not null,
    kind            varchar(24)  not null comment 'SIGNUP_BONUS/ADJUST/RECHARGE/HOLD/SETTLE/RELEASE',
    delta           bigint       not null comment '正数入账，负数出账',
    balance_after   bigint       not null comment '记账后的余额快照，对账时不用再累加',
    reason          varchar(200) null,
    ref_type        varchar(24)  null comment 'CHAT / ORDER / ADMIN',
    ref_id          varchar(64)  null,
    idempotency_key varchar(96)  null,
    created_at      datetime(6)  not null default current_timestamp(6),
    primary key (id),
    unique key uk_credit_ledger_idem (idempotency_key),
    key idx_credit_ledger_user (user_id, id desc),
    key idx_credit_ledger_ref (ref_type, ref_id),
    constraint fk_credit_ledger_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

create table credit_plans
(
    code          varchar(32)  not null,
    name          varchar(64)  not null,
    price_cents   int          not null comment '售价（分），避免浮点',
    credits       bigint       not null comment '到账积分（不含赠送）',
    bonus_credits bigint       not null default 0,
    tag           varchar(24)  null comment '「最受欢迎」这类角标',
    description   varchar(200) null,
    sort_order    int          not null default 0,
    active        tinyint(1)   not null default 1,
    primary key (code)
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

create table credit_orders
(
    id              bigint      not null auto_increment,
    order_no        char(36)    not null comment 'UUID，对外只暴露它，不暴露自增 id',
    user_id         bigint      not null,
    plan_code       varchar(32) not null,
    amount_cents    int         not null,
    credits         bigint      not null comment '实际到账（含赠送），下单时冻结下来，之后改套餐价不影响历史订单',
    status          varchar(16) not null comment 'PENDING / PAID / CANCELLED',
    provider        varchar(24) not null default 'mock',
    provider_txn_id varchar(96) null,
    paid_at         datetime(6) null,
    created_at      datetime(6) not null default current_timestamp(6),
    primary key (id),
    unique key uk_credit_orders_no (order_no),
    key idx_credit_orders_user (user_id, created_at),
    constraint fk_credit_orders_user foreign key (user_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;

-- 默认套餐。数值按「1 万字符上下文 + 1 千字符回答 ≈ 25 积分」估算：
--   体验包 ¥9 / 1000 分  ≈ 40 轮；开发者包 ¥49 / 6600 分 ≈ 264 轮。
insert into credit_plans (code, name, price_cents, credits, bonus_credits, tag, description, sort_order)
values ('starter', '体验包', 900, 1000, 0, null, '先把流程跑通，够用一阵子', 10),
       ('pro', '开发者包', 4900, 6000, 600, '最受欢迎', '每天用，单价更低，多送 600 分', 20),
       ('team', '团队包', 19900, 26000, 4000, '最划算', '给多人的工作区一起用', 30);
