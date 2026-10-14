-- 讨论室里自己的消息可以改。撤回过的不记这一栏。
alter table room_messages
    add column edited_at datetime(6) null after retracted_at;
