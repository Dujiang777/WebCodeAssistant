-- V7: 补丁变更说明。
--
-- propose_patch 现在接受一个 summary 参数（模型用一句话说明这个补丁做了什么）。
-- 在此之前 summary 只存在于模型的聊天文本里，补丁卡片上没有 —— 用户要在
-- 聊天记录里翻找「这个 diff 到底为什么长这样」。落库之后 summary 会跟着
-- patch 事件与补丁列表接口一路透传到前端卡片。
--
-- 可空：历史补丁没有 summary，前端对 null 显示为没有这一行。
alter table patches
    add column summary varchar(500) null after diff_text;
