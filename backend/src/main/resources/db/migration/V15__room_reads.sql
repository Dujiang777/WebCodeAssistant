-- 私聊已读位置。谁把和谁的对话读到了哪一条。
create table room_reads
(
    user_id      bigint not null,
    peer_id      bigint not null,
    last_read_id bigint not null,
    primary key (user_id, peer_id),
    constraint fk_room_reads_user foreign key (user_id) references users (id) on delete cascade,
    constraint fk_room_reads_peer foreign key (peer_id) references users (id) on delete cascade
) engine = InnoDB
  default charset = utf8mb4
  collate = utf8mb4_0900_ai_ci;
