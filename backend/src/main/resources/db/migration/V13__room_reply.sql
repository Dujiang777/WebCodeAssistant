-- 讨论室可以回复某一条，也可以撤回自己的消息。点名沿用提醒表，多一种 kind。
alter table room_messages
    add column reply_to_id bigint null after peer_id,
    add column retracted_at datetime(6) null after created_at,
    add constraint fk_room_reply foreign key (reply_to_id) references room_messages (id) on delete set null;

alter table room_notices
    drop check ck_room_notices_kind;

alter table room_notices
    add constraint ck_room_notices_kind check (kind in ('PUBLIC', 'DIRECT', 'MENTION'));
