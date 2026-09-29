-- 每周免费额度重置。
--
-- 设计：免费额度就是「余额补至 signupBonus」（≈¥5 的模型消耗），不另设资金池 ——
-- 好处是账本、对账、进度条全部复用现有余额体系，不出现「两本账」。
-- quota_reset_at 是下次重置时间：到点后第一次访问（summary / 发消息闸门）
-- 懒重置——余额低于赠送额就补差额，并顺延一个周期。NULL 表示还没初始化
-- （老数据迁移回填 +7 天，新账户由服务层在首次访问时初始化）。
ALTER TABLE credit_accounts
    ADD COLUMN quota_reset_at datetime(6) NULL AFTER total_consumed;

UPDATE credit_accounts
SET quota_reset_at = date_add(now(6), interval 7 day)
WHERE quota_reset_at IS NULL;
