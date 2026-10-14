-- 讨论室跨工作区，对方打不开发送者的文件。附上的是选中的代码原文，路径只作标题。
alter table room_messages
    add column excerpt varchar(2000) null after file_path,
    add column excerpt_start int null after excerpt,
    add column excerpt_end int null after excerpt_start;
