package com.webcode.assistant.credit;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

/**
 * credit_accounts 表访问。
 *
 * <p><b>这里是整个积分体系唯一允许改余额的地方。</b>
 * 每个方法都把「判断」写进 SQL 的 {@code where} 里，绝不允许
 * 「查出来 - 判断 - 写回去」——同一用户并发发两轮对话时，读改写必然扣成负数。
 *
 * <p>还有一条容易被忽略的约束：<b>结算时「余额变动」和「累计消耗」不是同一个数</b>。
 * 预扣阶段已经从余额里扣掉了 {@code hold}，但它不算「消耗」（因为还没花掉）。
 * 结算时真实消耗是 {@code actual}，于是：
 * <ul>
 *   <li>余额还要再动 {@code -(actual - hold)}（actual &gt; hold 就补扣，小于就退还）；</li>
 *   <li>累计消耗要增加 {@code actual}（而不是 {@code actual - hold}）。</li>
 * </ul>
 * 把这两个数混为一谈是最常见的记账 bug，所以 {@link #applySettle} 显式收两个参数。
 */
@Repository
public class CreditAccountRepository {

    public record CreditAccount(long userId, long balance, long totalGranted, long totalConsumed,
                                Instant updatedAt) {
    }

    private final JdbcClient jdbc;

    public CreditAccountRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * 确保账户存在。用 {@code on duplicate key update} 而不是「先查再插」：
     * 注册、赠送、充值三条路径都会调它，并发下「先查再插」会撞唯一键。
     * 更新列写成 {@code user_id = user_id} 是 MySQL 里「什么都不改」的标准写法。
     */
    public void ensureAccount(long userId) {
        jdbc.sql("insert into credit_accounts (user_id, balance) values (:u, 0) "
                        + "on duplicate key update user_id = user_id")
                .param("u", userId)
                .update();
    }

    public Optional<CreditAccount> find(long userId) {
        return jdbc.sql("select user_id, balance, total_granted, total_consumed, updated_at "
                        + "from credit_accounts where user_id = :u")
                .param("u", userId)
                .query(CreditAccountRepository::map)
                .optional();
    }

    public long balance(long userId) {
        return find(userId).map(CreditAccount::balance).orElse(0L);
    }

    /** 入账：余额 +，累计获得 +。注册赠送、充值、管理员加都走这里。 */
    public void grant(long userId, long amount) {
        jdbc.sql("update credit_accounts set balance = balance + :a, total_granted = total_granted + :a "
                        + "where user_id = :u")
                .param("a", amount)
                .param("u", userId)
                .update();
    }

    /**
     * 出账：余额 -，但不动累计消耗。预扣（HOLD）用它。
     *
     * @return false 表示余额不足，什么都没改
     */
    public boolean debit(long userId, long amount) {
        return jdbc.sql("update credit_accounts set balance = balance - :a "
                        + "where user_id = :u and balance >= :a")
                .param("a", amount)
                .param("u", userId)
                .update() == 1;
    }

    /**
     * 结算：余额按 {@code charged} 调整（负数=补扣，正数=退还），累计消耗增加 {@code consumed}。
     *
     * @param charged  余额变动量，通常等于 {@code actual - hold}
     * @param consumed 本轮计入「累计消耗」的额度，通常等于 actual
     * @return false 表示需要补扣但余额不够（此时不做任何修改，由调用方决定怎么兜底）
     */
    public boolean applySettle(long userId, long charged, long consumed) {
        if (charged >= 0) {
            jdbc.sql("update credit_accounts set balance = balance + :c, total_consumed = total_consumed + :d "
                            + "where user_id = :u")
                    .param("c", charged)
                    .param("d", consumed)
                    .param("u", userId)
                    .update();
            return true;
        }
        long need = -charged;
        return jdbc.sql("update credit_accounts set balance = balance + :c, total_consumed = total_consumed + :d "
                        + "where user_id = :u and balance >= :need")
                .param("c", charged)
                .param("d", consumed)
                .param("u", userId)
                .param("need", need)
                .update() == 1;
    }

    /** 退款：余额 +，累计获得与消耗都不动（它不是「获得」，是「收回本来就没该扣的」）。 */
    public void refund(long userId, long amount) {
        jdbc.sql("update credit_accounts set balance = balance + :a where user_id = :u")
                .param("a", amount)
                .param("u", userId)
                .update();
    }

    public Optional<CreditAccount> findByUsername(String username) {
        return jdbc.sql("select a.user_id, a.balance, a.total_granted, a.total_consumed, a.updated_at "
                        + "from credit_accounts a join users u on u.id = a.user_id where u.username = :n")
                .param("n", username)
                .query(CreditAccountRepository::map)
                .optional();
    }

    /**
     * 对账修正：把余额直接对齐成账本的累计值。
     *
     * <p>只在「账本是对的，账户快照漂了」时使用。反向不成立 ——
     * 如果账本本身有问题，这个方法会把错误固化，所以它只由管理员显式触发，
     * 不会在任何自动流程里被调用。
     */
    public void resetBalanceFromLedger(long userId) {
        jdbc.sql("update credit_accounts set balance = "
                        + "coalesce((select sum(delta) from credit_ledger where user_id = :u), 0) "
                        + "where user_id = :u")
                .param("u", userId)
                .update();
    }

    private static CreditAccount map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new CreditAccount(
                rs.getLong("user_id"),
                rs.getLong("balance"),
                rs.getLong("total_granted"),
                rs.getLong("total_consumed"),
                rs.getTimestamp("updated_at").toInstant());
    }
}
