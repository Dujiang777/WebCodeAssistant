-- V8：订单退款。
-- 退款是对「已支付」订单的资金操作：PAID → REFUNDED 的条件跃迁由
-- markRefunded 的 where status='PAID' 保证只发生一次；
-- refunded_at / refund_reason 让审计能回答「这笔钱什么时候、为什么退的」。
alter table credit_orders
    add column refunded_at datetime(6) null comment '退款完成时间' after paid_at,
    add column refund_reason varchar(255) null comment '退款理由（管理员填写）' after refunded_at;
