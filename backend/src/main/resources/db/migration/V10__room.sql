-- 讨论室：登录用户之间的公屏与一对一私聊。
-- peer_id 为空是公屏；有值则是发给该用户的私聊（对方回消息时方向对调）。
create table room_messages
(
    id         bigint       not null auto_increment,
    sender_id  bigint       not null,
    peer_id    bigint       null,
    body       varchar(1000) not null,
    file_path  varchar(240) null,
    created_at datetime(6)  not null default current_timestamp(6),
    primary key (id),
    key idx_room_public (peer_id, id),
    key idx_room_sender (sender_id, id),
    constraint fk_room_sender foreign key (sender_id) references users (id) on delete cascade,
    constraint fk_room_peer foreign key (peer_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
