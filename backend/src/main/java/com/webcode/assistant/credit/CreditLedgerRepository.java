package com.webcode.assistant.credit;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

/**
 * credit_ledger 表访问。**只增不改**。
 *
 * <p>为什么要一本流水账，而不是只在账户上放一个余额：
 * 「余额对不对」这个问题的答案必须能从事实推导出来。余额是快照，
 * 用户说「我明明有 500 分」时，唯一能自证的方式就是把所有变动摊开给他看。
 * 对账时 {@code sum(delta)} 必须等于 {@code balance}，不相等就是有 bug。
 *
 * <p>为什么 {@code balance_after} 要冗余存一份：流水分页展示时，
 * 每一行都要显示「这笔之后的余额」，如果靠累加计算，翻到第 5 页就得把前 4 页全扫一遍。
 */
@Repository
public class CreditLedgerRepository {

    /** 积分变动类型。字符串而不是枚举存库：加类型不需要改表。 */
    public static final String KIND_SIGNUP_BONUS = "SIGNUP_BONUS";
    public static final String KIND_ADJUST = "ADJUST";
    public static final String KIND_RECHARGE = "RECHARGE";
    public static final String KIND_HOLD = "HOLD";
    public static final String KIND_SETTLE = "SETTLE";
    public static final String KIND_RELEASE = "RELEASE";

    public record LedgerEntry(long id, long userId, String kind, long delta, long balanceAfter,
                              String reason, String refType, String refId, Instant createdAt) {
    }

    public record LedgerPage(List<LedgerEntry> items, long total) {
    }

    private static final String COLUMNS =
            "id, user_id, kind, delta, balance_after, reason, ref_type, ref_id, created_at";

    private final JdbcClient jdbc;

    public CreditLedgerRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(long userId, String kind, long delta, long balanceAfter, String reason,
                       String refType, String refId, String idempotencyKey) {
        jdbc.sql("insert into credit_ledger "
                        + "(user_id, kind, delta, balance_after, reason, ref_type, ref_id, idempotency_key) "
                        + "values (:u, :k, :d, :b, :r, :rt, :ri, :ik)")
                .param("u", userId)
                .param("k", kind)
                .param("d", delta)
                .param("b", balanceAfter)
                .param("r", reason)
                .param("rt", refType)
                .param("ri", refId)
                .param("ik", idempotencyKey)
                .update();
    }

    /**
     * 幂等键是否已用过。
     *
     * <p>这是「快速路径」的检查：命中就直接跳过，避免每次都靠唯一键异常来控制流程
     * （异常开销大，而且会污染日志）。真正的兜底是唯一索引本身 ——
     * 因为余额变动与账本写入在同一个事务里，重复插入会让整个事务回滚，
     * 余额不会被重复扣。
     */
    public boolean existsByIdempotencyKey(String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return false;
        }
        return jdbc.sql("select exists(select 1 from credit_ledger where idempotency_key = :k)")
                .param("k", idempotencyKey)
                .query(Boolean.class)
                .single();
    }

    public LedgerPage page(long userId, int limit, int offset) {
        List<LedgerEntry> items = jdbc.sql("select " + COLUMNS + " from credit_ledger "
                        + "where user_id = :u order by id desc limit :l offset :o")
                .param("u", userId)
                .param("l", limit)
                .param("o", offset)
                .query(CreditLedgerRepository::map)
                .list();
        long total = jdbc.sql("select count(*) from credit_ledger where user_id = :u")
                .param("u", userId)
                .query(Long.class)
                .single();
        return new LedgerPage(items, total);
    }

    public List<LedgerEntry> listByRef(long userId, String refType, String refId) {
        return jdbc.sql("select " + COLUMNS + " from credit_ledger "
                        + "where user_id = :u and ref_type = :rt and ref_id = :ri order by id")
                .param("u", userId)
                .param("rt", refType)
                .param("ri", refId)
                .query(CreditLedgerRepository::map)
                .list();
    }

    /** 对账用：账本累计值。正常情况下它必须等于账户余额。 */
    public long sumDelta(long userId) {
        Long sum = jdbc.sql("select coalesce(sum(delta), 0) from credit_ledger where user_id = :u")
                .param("u", userId)
                .query(Long.class)
                .single();
        return sum == null ? 0L : sum;
    }

    private static LedgerEntry map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new LedgerEntry(
                rs.getLong("id"),
                rs.getLong("user_id"),
                rs.getString("kind"),
                rs.getLong("delta"),
                rs.getLong("balance_after"),
                rs.getString("reason"),
                rs.getString("ref_type"),
                rs.getString("ref_id"),
                rs.getTimestamp("created_at").toInstant());
    }
}
