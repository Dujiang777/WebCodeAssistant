-- 每个账号一条未读队列。公屏发给除自己以外的人，私聊只发给对方。
create table room_notices
(
    id          bigint       not null auto_increment,
    user_id     bigint       not null,
    message_id  bigint       not null,
    kind        varchar(16)  not null,
    sender_id   bigint       not null,
    sender_name varchar(64)  not null,
    preview     varchar(180) not null,
    peer_id     bigint       null,
    created_at  datetime(6)  not null default current_timestamp(6),
    read_at     datetime(6)  null,
    primary key (id),
    unique key uk_room_notice (user_id, message_id),
    key idx_room_notices_unread (user_id, read_at, id),
    constraint fk_room_notices_user foreign key (user_id) references users (id) on delete cascade,
    constraint fk_room_notices_msg foreign key (message_id) references room_messages (id) on delete cascade,
    constraint ck_room_notices_kind check (kind in ('PUBLIC', 'DIRECT'))
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
