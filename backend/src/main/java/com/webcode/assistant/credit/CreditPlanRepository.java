package com.webcode.assistant.credit;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/**
 * credit_plans 表访问。套餐是「配置」而不是「代码」，运营改价格不该等发版。
 */
@Repository
public class CreditPlanRepository {

    public record CreditPlan(String code, String name, int priceCents, long credits, long bonusCredits,
                             String tag, String description, int sortOrder, boolean active) {

        /** 实际到账 = 基础积分 + 赠送。前端也要显示这个数，所以由后端算好。 */
        public long totalCredits() {
            return credits + bonusCredits;
        }

        /** 单价（分/千分），用于在套餐卡上显示「约 ¥x / 千分」，让用户能横向比价。 */
        public long centsPerKiloCredit() {
            return totalCredits() == 0 ? 0 : Math.round(priceCents * 1000.0 / totalCredits());
        }
    }

    private static final String COLUMNS =
            "code, name, price_cents, credits, bonus_credits, tag, description, sort_order, active";

    private final JdbcClient jdbc;

    public CreditPlanRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<CreditPlan> listActive() {
        return jdbc.sql("select " + COLUMNS + " from credit_plans where active = 1 order by sort_order, code")
                .query(CreditPlanRepository::map)
                .list();
    }

    public Optional<CreditPlan> find(String code) {
        return jdbc.sql("select " + COLUMNS + " from credit_plans where code = :c")
                .param("c", code)
                .query(CreditPlanRepository::map)
                .optional();
    }

    private static CreditPlan map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new CreditPlan(
                rs.getString("code"),
                rs.getString("name"),
                rs.getInt("price_cents"),
                rs.getLong("credits"),
                rs.getLong("bonus_credits"),
                rs.getString("tag"),
                rs.getString("description"),
                rs.getInt("sort_order"),
                rs.getBoolean("active"));
    }
}
