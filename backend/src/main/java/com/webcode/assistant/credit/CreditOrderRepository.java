package com.webcode.assistant.credit;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * credit_orders 表访问。
 *
 * <p><b>{@link #markPaid} 是支付幂等的唯一闸门</b>：它用
 * {@code where status = 'PENDING'} 做条件更新，返回影响行数。
 * 支付通道的回调会重试很多次（这是常态，不是异常），
 * 只有第一次能把 PENDING 改成 PAID，后面的全部返回 false 并被忽略。
 * 这样一来，「回调重试导致重复到账」这个问题在数据层就被堵死了，
 * 业务代码不需要写任何分布式锁。
 */
@Repository
public class CreditOrderRepository {

    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_PAID = "PAID";
    public static final String STATUS_CANCELLED = "CANCELLED";

    public record CreditOrder(long id, String orderNo, long userId, String planCode, int amountCents,
                              long credits, String status, String provider, String providerTxnId,
                              Instant paidAt, Instant createdAt) {
    }

    private static final String COLUMNS =
            "id, order_no, user_id, plan_code, amount_cents, credits, status, provider, "
                    + "provider_txn_id, paid_at, created_at";

    private final JdbcClient jdbc;

    public CreditOrderRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(String orderNo, long userId, String planCode, int amountCents, long credits, String provider) {
        jdbc.sql("insert into credit_orders "
                        + "(order_no, user_id, plan_code, amount_cents, credits, status, provider) "
                        + "values (:no, :u, :p, :a, :c, :s, :pv)")
                .param("no", orderNo)
                .param("u", userId)
                .param("p", planCode)
                .param("a", amountCents)
                .param("c", credits)
                .param("s", STATUS_PENDING)
                .param("pv", provider)
                .update();
    }

    public Optional<CreditOrder> find(String orderNo) {
        return jdbc.sql("select " + COLUMNS + " from credit_orders where order_no = :no")
                .param("no", orderNo)
                .query(CreditOrderRepository::map)
                .optional();
    }

    /**
     * 把订单从 PENDING 推到 PAID。
     *
     * @return true 表示<b>这次调用</b>完成了状态跃迁（首次支付成功，可以入账）；
     *         false 表示订单不存在、已支付过或已取消（重复回调，直接忽略）
     */
    public boolean markPaid(String orderNo, String providerTxnId) {
        return jdbc.sql("update credit_orders set status = :paid, provider_txn_id = :txn, paid_at = now(6) "
                        + "where order_no = :no and status = :pending")
                .param("paid", STATUS_PAID)
                .param("txn", providerTxnId)
                .param("no", orderNo)
                .param("pending", STATUS_PENDING)
                .update() == 1;
    }

    public boolean cancel(String orderNo, long userId) {
        return jdbc.sql("update credit_orders set status = :c where order_no = :no and user_id = :u "
                        + "and status = :pending")
                .param("c", STATUS_CANCELLED)
                .param("no", orderNo)
                .param("u", userId)
                .param("pending", STATUS_PENDING)
                .update() == 1;
    }

    public List<CreditOrder> listByUser(long userId, int limit) {
        return jdbc.sql("select " + COLUMNS + " from credit_orders where user_id = :u "
                        + "order by id desc limit :l")
                .param("u", userId)
                .param("l", limit)
                .query(CreditOrderRepository::map)
                .list();
    }

    private static CreditOrder map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp paidAt = rs.getTimestamp("paid_at");
        return new CreditOrder(
                rs.getLong("id"),
                rs.getString("order_no"),
                rs.getLong("user_id"),
                rs.getString("plan_code"),
                rs.getInt("amount_cents"),
                rs.getLong("credits"),
                rs.getString("status"),
                rs.getString("provider"),
                rs.getString("provider_txn_id"),
                paidAt == null ? null : paidAt.toInstant(),
                rs.getTimestamp("created_at").toInstant());
    }
}
