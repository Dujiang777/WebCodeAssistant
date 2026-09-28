package com.webcode.assistant.admin;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 管理端数据访问：用户列表/详情、统计、管理操作审计。
 *
 * <p><b>列表查询的过滤条件是动态拼的</b>，不是「{@code :kw is null or ...}」那种写法。
 * 后者看着简洁，但 MySQL 对「无名参数 + null」的类型推断经常给出
 * 「Illegal mix of collations」或「Data truncation」，而且它会让优化器无法走索引。
 * 动态拼接 + 具名参数虽然啰嗦，但每一段的参数都是强类型的，行为可预期。
 *
 * <p><b>审计只增不改</b>：没有任何 update / delete 方法，这是刻意的 ——
 * 「管理员能改审计」等于没有审计。
 */
@Repository
public class AdminRepository {

    /**
     * 列表行。
     *
     * <p>{@code locked} 是算出来的（{@code locked_until > now()}）而不是读一个布尔列 ——
     * 锁定的判据是时间，存布尔就会需要定时任务去解锁，而那个任务一定会漏跑。
     */
    public record AdminUserRow(
            long id,
            String username,
            String email,
            boolean emailVerified,
            String role,
            String status,
            boolean locked,
            String disabledReason,
            long balance,
            long totalGranted,
            long totalConsumed,
            Instant lastLoginAt,
            Instant createdAt
    ) {
    }

    /** 审计行。{@code operatorName} 冗余存下来，用户改名或注销后审计仍然可读。 */
    public record AuditRow(
            long id,
            long operatorId,
            String operatorName,
            String action,
            String targetType,
            String targetId,
            String targetName,
            String detail,
            String ip,
            Instant createdAt
    ) {
    }

    /** 统计看板。 */
    public record Stats(
            long totalUsers,
            long newUsersToday,
            long activeToday,
            long admins,
            long disabledUsers,
            long lockedUsers,
            long unverifiedEmail,
            long pendingOrders,
            long paidOrders,
            long totalCreditsGranted,
            long totalCreditsConsumed,
            long creditsToday,
            long turnsToday
    ) {
    }

    /** 一行「按天聚合」的走势数据。 */
    public record DailyPoint(String day, long signups, long credits) {
    }

    private static final String USER_COLUMNS =
            "u.id, u.username, u.email, u.email_verified, u.role, u.status, u.disabled_reason, "
                    + "u.locked_until, u.last_login_at, u.created_at, "
                    + "coalesce(a.balance, 0) as balance, "
                    + "coalesce(a.total_granted, 0) as total_granted, "
                    + "coalesce(a.total_consumed, 0) as total_consumed";

    private static final String USER_FROM =
            " from users u left join credit_accounts a on a.user_id = u.id ";

    private static final String AUDIT_COLUMNS =
            "id, operator_id, operator_name, action, target_type, target_id, target_name, detail, ip, created_at";

    private final JdbcClient jdbc;

    public AdminRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------ 用户列表

    /** 过滤条件。全为 null 表示不过滤。 */
    public record UserFilter(String keyword, String role, String status, Boolean emailVerified) {
    }

    public long countUsers(UserFilter filter) {
        StringBuilder sql = new StringBuilder("select count(*) from users u where 1 = 1");
        List<Object[]> params = new ArrayList<>();
        appendFilter(sql, params, filter);
        JdbcClient.StatementSpec spec = jdbc.sql(sql.toString());
        for (Object[] pair : params) {
            spec = spec.param((String) pair[0], pair[1]);
        }
        return spec.query(Long.class).single();
    }

    public List<AdminUserRow> pageUsers(UserFilter filter, String sort, int size, int offset) {
        StringBuilder sql = new StringBuilder("select " + USER_COLUMNS + USER_FROM + " where 1 = 1");
        List<Object[]> params = new ArrayList<>();
        appendFilter(sql, params, filter);
        // 排序字段白名单 —— 直接拼用户传来的字符串就是 SQL 注入
        sql.append(switch (sort == null ? "" : sort) {
            case "credits" -> " order by balance desc, u.id desc";
            case "consumed" -> " order by total_consumed desc, u.id desc";
            case "login" -> " order by u.last_login_at is null, u.last_login_at desc, u.id desc";
            case "oldest" -> " order by u.created_at asc, u.id asc";
            default -> " order by u.created_at desc, u.id desc";
        });
        sql.append(" limit :limit offset :offset");

        JdbcClient.StatementSpec spec = jdbc.sql(sql.toString());
        for (Object[] pair : params) {
            spec = spec.param((String) pair[0], pair[1]);
        }
        return spec.param("limit", size).param("offset", offset)
                .query(AdminRepository::mapUser)
                .list();
    }

    private static void appendFilter(StringBuilder sql, List<Object[]> params, UserFilter filter) {
        if (filter == null) {
            return;
        }
        if (filter.keyword() != null && !filter.keyword().isBlank()) {
            // 前缀匹配（like 'kw%'）而不是 '%%kw%%'：后者用不上索引，
            // 用户量大起来之后这个接口会变成全表扫描。
            sql.append(" and (u.username like :kwPrefix or u.email like :kwPrefix)");
            params.add(new Object[]{"kwPrefix", filter.keyword().trim() + "%"});
        }
        if (filter.role() != null && !filter.role().isBlank()) {
            sql.append(" and u.role = :role");
            params.add(new Object[]{"role", filter.role()});
        }
        if (filter.status() != null && !filter.status().isBlank()) {
            sql.append(" and u.status = :status");
            params.add(new Object[]{"status", filter.status()});
        }
        if (filter.emailVerified() != null) {
            sql.append(" and u.email_verified = :verified");
            params.add(new Object[]{"verified", filter.emailVerified()});
        }
    }

    public Optional<AdminUserRow> findUser(long id) {
        return jdbc.sql("select " + USER_COLUMNS + USER_FROM + " where u.id = :id")
                .param("id", id)
                .query(AdminRepository::mapUser)
                .optional();
    }

    // ------------------------------------------------------------ 用户处置

    /** 停用。记下原因、时间、操作人 —— 客服最常问的「我账号怎么不能用了」当场能答。 */
    public int disable(long userId, String reason, Long operatorId) {
        return jdbc.sql("update users set status = 'DISABLED', disabled_reason = :reason, "
                        + "disabled_at = now(6), disabled_by = :op, failed_attempts = 0, locked_until = null "
                        + "where id = :id")
                .param("reason", reason)
                .param("op", operatorId)
                .param("id", userId)
                .update();
    }

    public int enable(long userId) {
        return jdbc.sql("update users set status = 'ACTIVE', disabled_reason = null, "
                        + "disabled_at = null, disabled_by = null where id = :id")
                .param("id", userId)
                .update();
    }

    /** 解除登录锁定。只清锁定，不动失败计数 —— 计数会在下次成功登录时清零。 */
    public int unlock(long userId) {
        return jdbc.sql("update users set locked_until = null, failed_attempts = 0 where id = :id")
                .param("id", userId)
                .update();
    }

    public int updateRole(long userId, String role) {
        return jdbc.sql("update users set role = :role where id = :id")
                .param("role", role)
                .param("id", userId)
                .update();
    }

    public int updatePasswordHash(long userId, String passwordHash) {
        return jdbc.sql("update users set password_hash = :p, failed_attempts = 0, locked_until = null "
                        + "where id = :id")
                .param("p", passwordHash)
                .param("id", userId)
                .update();
    }

    /** 统计某角色还有多少个「可用」的账号（ACTIVE 且未停用）。用于「不能动最后一个管理员」的守卫。 */
    public long countActiveAdmins() {
        return jdbc.sql("select count(*) from users where role = 'ADMIN' and status = 'ACTIVE'")
                .query(Long.class)
                .single();
    }

    // ------------------------------------------------------------ 订单

    public record AdminOrderRow(
            String orderNo,
            long userId,
            String username,
            String planCode,
            int amountCents,
            long credits,
            String status,
            String provider,
            Instant createdAt,
            Instant paidAt,
            Instant refundedAt,
            String refundReason
    ) {
    }

    public long countOrders(String status) {
        boolean filtered = status != null && !status.isBlank();
        return jdbc.sql("select count(*) from credit_orders" + (filtered ? " where status = :status" : ""))
                .param("status", status)
                .query(Long.class)
                .single();
    }

    public List<AdminOrderRow> pageOrders(String status, int size, int offset) {
        boolean filtered = status != null && !status.isBlank();
        return jdbc.sql("select o.order_no, o.user_id, coalesce(u.username, '（已注销）') as username, "
                        + "o.plan_code, o.amount_cents, o.credits, o.status, o.provider, "
                        + "o.created_at, o.paid_at, o.refunded_at, o.refund_reason "
                        + "from credit_orders o left join users u on u.id = o.user_id "
                        + (filtered ? "where o.status = :status " : "")
                        + "order by o.created_at desc, o.id desc limit :limit offset :offset")
                .param("status", status)
                .param("limit", size)
                .param("offset", offset)
                .query(AdminRepository::mapOrder)
                .list();
    }

    /** 撤销订单：只允许 PENDING → CANCELLED。条件更新保证「已支付的不可能被撤销」。 */
    public int cancelOrder(String orderNo) {
        return jdbc.sql("update credit_orders set status = 'CANCELLED' "
                        + "where order_no = :no and status = 'PENDING'")
                .param("no", orderNo)
                .update();
    }

    // ------------------------------------------------------------ 审计

    public void audit(long operatorId, String operatorName, String action, String targetType,
                      String targetId, String targetName, String detail, String ip) {
        jdbc.sql("insert into admin_audit (operator_id, operator_name, action, target_type, target_id, "
                        + "target_name, detail, ip) "
                        + "values (:op, :opName, :action, :tType, :tId, :tName, :detail, :ip)")
                .param("op", operatorId)
                .param("opName", operatorName)
                .param("action", action)
                .param("tType", targetType)
                .param("tId", targetId)
                .param("tName", targetName)
                .param("detail", detail)
                .param("ip", ip)
                .update();
    }

    public long countAudit(String action) {
        boolean filtered = action != null && !action.isBlank();
        return jdbc.sql("select count(*) from admin_audit" + (filtered ? " where action = :action" : ""))
                .param("action", action)
                .query(Long.class)
                .single();
    }

    public List<AuditRow> pageAudit(String action, int size, int offset) {
        boolean filtered = action != null && !action.isBlank();
        return jdbc.sql("select " + AUDIT_COLUMNS + " from admin_audit "
                        + (filtered ? "where action = :action " : "")
                        + "order by created_at desc, id desc limit :limit offset :offset")
                .param("action", action)
                .param("limit", size)
                .param("offset", offset)
                .query(AdminRepository::mapAudit)
                .list();
    }

    public List<AuditRow> recentAuditFor(String targetType, String targetId, int limit) {
        return jdbc.sql("select " + AUDIT_COLUMNS + " from admin_audit "
                        + "where target_type = :tType and target_id = :tId "
                        + "order by created_at desc, id desc limit :limit")
                .param("tType", targetType)
                .param("tId", targetId)
                .param("limit", limit)
                .query(AdminRepository::mapAudit)
                .list();
    }

    // ------------------------------------------------------------ 统计

    public Stats stats() {
        return jdbc.sql("""
                        select
                          (select count(*) from users) as total_users,
                          (select count(*) from users where created_at >= curdate()) as new_today,
                          (select count(*) from users where last_login_at >= curdate()) as active_today,
                          (select count(*) from users where role = 'ADMIN') as admins,
                          (select count(*) from users where status <> 'ACTIVE') as disabled_users,
                          (select count(*) from users where locked_until > now(6)) as locked_users,
                          (select count(*) from users where email is not null and email_verified = 0) as unverified,
                          (select count(*) from credit_orders where status = 'PENDING') as pending_orders,
                          (select count(*) from credit_orders where status = 'PAID') as paid_orders,
                          (select coalesce(sum(total_granted), 0) from credit_accounts) as granted,
                          (select coalesce(sum(total_consumed), 0) from credit_accounts) as consumed,
                          (select coalesce(-sum(delta), 0) from credit_ledger where delta < 0 and created_at >= curdate()) as credits_today,
                          (select count(*) from chat_messages where role = 'USER' and created_at >= curdate()) as turns_today
                        """)
                .query((rs, rowNum) -> new Stats(
                        rs.getLong("total_users"),
                        rs.getLong("new_today"),
                        rs.getLong("active_today"),
                        rs.getLong("admins"),
                        rs.getLong("disabled_users"),
                        rs.getLong("locked_users"),
                        rs.getLong("unverified"),
                        rs.getLong("pending_orders"),
                        rs.getLong("paid_orders"),
                        rs.getLong("granted"),
                        rs.getLong("consumed"),
                        rs.getLong("credits_today"),
                        rs.getLong("turns_today")))
                .single();
    }

    /** 近 N 天的注册与消耗走势。 */
    public List<DailyPoint> dailyTrend(int days) {
        int safeDays = Math.min(Math.max(days, 1), 30);
        return jdbc.sql("""
                        select d.day,
                               coalesce(s.signups, 0) as signups,
                               coalesce(c.credits, 0) as credits
                        from (
                          select date_sub(curdate(), interval seq day) as day
                          from (
                            select 0 as seq union all select 1 union all select 2 union all select 3
                            union all select 4 union all select 5 union all select 6 union all select 7
                            union all select 8 union all select 9 union all select 10 union all select 11
                            union all select 12 union all select 13 union all select 14 union all select 15
                            union all select 16 union all select 17 union all select 18 union all select 19
                            union all select 20 union all select 21 union all select 22 union all select 23
                            union all select 24 union all select 25 union all select 26 union all select 27
                            union all select 28 union all select 29
                          ) seqs
                          where seq < :days
                        ) d
                        left join (
                          select date(created_at) as day, count(*) as signups
                          from users group by date(created_at)
                        ) s on s.day = d.day
                        left join (
                          select date(created_at) as day, -sum(delta) as credits
                          from credit_ledger where delta < 0 group by date(created_at)
                        ) c on c.day = d.day
                        order by d.day
                        """)
                .param("days", safeDays)
                .query((rs, rowNum) -> new DailyPoint(
                        String.valueOf(rs.getDate("day")),
                        rs.getLong("signups"),
                        rs.getLong("credits")))
                .list();
    }

    // ------------------------------------------------------------ 映射

    private static AdminUserRow mapUser(ResultSet rs, int rowNum) throws SQLException {
        Timestamp lockedUntil = rs.getTimestamp("locked_until");
        return new AdminUserRow(
                rs.getLong("id"),
                rs.getString("username"),
                rs.getString("email"),
                rs.getBoolean("email_verified"),
                rs.getString("role"),
                rs.getString("status"),
                lockedUntil != null && lockedUntil.toInstant().isAfter(Instant.now()),
                rs.getString("disabled_reason"),
                rs.getLong("balance"),
                rs.getLong("total_granted"),
                rs.getLong("total_consumed"),
                instantOrNull(rs.getTimestamp("last_login_at")),
                instantOrNull(rs.getTimestamp("created_at")));
    }

    private static AdminOrderRow mapOrder(ResultSet rs, int rowNum) throws SQLException {
        return new AdminOrderRow(
                rs.getString("order_no"),
                rs.getLong("user_id"),
                rs.getString("username"),
                rs.getString("plan_code"),
                rs.getInt("amount_cents"),
                rs.getLong("credits"),
                rs.getString("status"),
                rs.getString("provider"),
                instantOrNull(rs.getTimestamp("created_at")),
                instantOrNull(rs.getTimestamp("paid_at")),
                instantOrNull(rs.getTimestamp("refunded_at")),
                rs.getString("refund_reason"));
    }

    private static AuditRow mapAudit(ResultSet rs, int rowNum) throws SQLException {
        return new AuditRow(
                rs.getLong("id"),
                rs.getLong("operator_id"),
                rs.getString("operator_name"),
                rs.getString("action"),
                rs.getString("target_type"),
                rs.getString("target_id"),
                rs.getString("target_name"),
                rs.getString("detail"),
                rs.getString("ip"),
                instantOrNull(rs.getTimestamp("created_at")));
    }

    private static Instant instantOrNull(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }
}
