import { useEffect, useState } from 'react';

import {
  api,
  formatDateTime,
  formatDelta,
  formatYuan,
  LEDGER_KINDS,
  loadUser,
  subscribeSession,
  updateCredits,
} from '../lib/api';
import type {
  AuthUser,
  CreditOrder,
  CreditPlan,
  CreditSummary,
  LedgerPage,
  OrderResponse,
  ReconcileResult,
} from '../lib/api';
import { messageOf } from '../lib/chat';
import { PageBar } from '../components/PageBar';
import { CloseIcon, CreditIcon } from '../components/icons';

/**
 * 积分中心：余额、套餐、订单、流水、对账。
 *
 * 这个页面要回答四个问题，顺序也是按用户真实的疑问排的：
 *   1. 我还剩多少？（余额大字，进页面第一眼）
 *   2. 怎么变少的？（流水表，每一笔都能点开看来源）
 *   3. 怎么充值？（套餐卡片 → 下单 → 支付）
 *   4. 这些数字可信吗？（对账按钮，余额与账本累计值当场对比）
 *
 * 第 4 点是刻意的：积分就是钱，一个不能自查的余额系统不值得信任。
 * 后端把 `sum(ledger.delta)` 与账户快照放在一起返回，这里只做展示。
 *
 * 关于流水的一个小陷阱：预扣（HOLD）与结算（SETTLE）是**两笔**记录，
 * 净额才是这一轮的实际花费。不解释这一点，用户会把「−30 又 +27」读成扣了两次钱。
 */

const PAGE_SIZE = 20;

export function CreditsPage({ onBack, onLogout }: { onBack: () => void; onLogout: () => void }) {
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [plans, setPlans] = useState<CreditPlan[]>([]);
  const [orders, setOrders] = useState<CreditOrder[]>([]);
  const [ledger, setLedger] = useState<LedgerPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<OrderResponse | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => subscribeSession(setUser), []);

  const loadLedger = async (nextOffset: number) => {
    const page = await api.creditLedger(PAGE_SIZE, nextOffset);
    setLedger(page);
    setOffset(nextOffset);
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [balance, planList, orderList, page] = await Promise.all([
        api.creditSummary(),
        api.creditPlans(),
        api.creditOrders(),
        api.creditLedger(PAGE_SIZE, 0),
      ]);
      setSummary(balance);
      setPlans(planList);
      setOrders(orderList);
      setLedger(page);
      setOffset(0);
      updateCredits(balance.balance, balance.lowBalance);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 下单：拿到支付参数后弹确认框。真实的收银台是在这一步返回二维码 / 跳转 URL。 */
  const buy = async (plan: CreditPlan) => {
    setBusyPlan(plan.code);
    setError(null);
    setNotice(null);
    try {
      setCheckout(await api.createOrder(plan.code));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyPlan(null);
    }
  };

  const refreshAfterPayment = async () => {
    const [balance, orderList, page] = await Promise.all([
      api.creditSummary(),
      api.creditOrders(),
      api.creditLedger(PAGE_SIZE, 0),
    ]);
    setSummary(balance);
    setOrders(orderList);
    setLedger(page);
    setOffset(0);
    updateCredits(balance.balance, balance.lowBalance);
  };

  /**
   * 支付确认。
   *
   * 刻意做成「可以重复点」：真实支付通道的回调一定会重试，服务端靠
   * 「订单状态条件更新 + 账本幂等键」两层保证不会重复到账。
   * 前端不做「点过就禁用」的假保护 —— 那样只会掩盖服务端幂等有没有做对。
   */
  const confirmPay = async () => {
    if (!checkout) return;
    const payToken = String(checkout.payment.payToken ?? '');
    setPaying(true);
    setError(null);
    try {
      const order = await api.payOrder(checkout.order.orderNo, payToken);
      await refreshAfterPayment();
      setCheckout(null);
      setNotice(
        order.status === 'PAID'
          ? `支付成功，${order.credits} 积分已到账。`
          : `订单状态：${order.status}`,
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPaying(false);
    }
  };

  /** 待支付订单的「继续支付」：回到通道重新取一份支付参数（旧凭证会过期）。 */
  const resumePay = async (order: CreditOrder) => {
    setBusyOrder(order.orderNo);
    setError(null);
    try {
      setCheckout(await api.reissuePayment(order.orderNo));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyOrder(null);
    }
  };

  const cancelOrder = async (orderNo: string) => {
    setBusyOrder(orderNo);
    setError(null);
    try {
      await api.cancelOrder(orderNo);
      setOrders(await api.creditOrders());
      setNotice('订单已取消。');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyOrder(null);
    }
  };

  const runReconcile = async () => {
    setError(null);
    try {
      setReconcile(await api.reconcileCredits());
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const balance = summary?.balance ?? null;
  const pendingOrders = orders.filter((order) => order.status === 'PENDING').length;
  const from = ledger && ledger.total > 0 ? offset + 1 : 0;
  const to = ledger ? Math.min(offset + PAGE_SIZE, offset + (ledger.items.length)) : 0;

  return (
    <div className="page">
      <PageBar
        title="积分中心"
        subtitle={user?.username ?? ''}
        balance={balance}
        lowBalance={summary?.lowBalance ?? false}
        active="credits"
        onBack={onBack}
        onLogout={onLogout}
      />

      <main className="page-scroll">
        <div className="page-wrap">
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}

          {summary?.lowBalance && (
            <div className="banner banner-credit">
              <span className="dot dot-err" />
              <span className="banner-text">
                余额已低于告警线（{summary.lowBalanceThreshold} 分）。每轮对话都要先预扣 {summary.holdCredits}
                {' '}分，余额不足时会被直接拒绝。
              </span>
            </div>
          )}

          {/* ---------------------------------------------------------- 余额 */}
          <section className="cr-hero">
            <div className="cr-balance">
              <span className="cr-balance-label">当前余额</span>
              <div className="cr-balance-row">
                <span className="cr-balance-value">{summary ? summary.balance : '—'}</span>
                <span className="cr-balance-unit">积分</span>
              </div>
            </div>

            <div className="cr-stats">
              <div className="cr-stat">
                <span className="cr-stat-label">累计获得</span>
                <b className="cr-stat-value in">+{summary?.totalGranted ?? 0}</b>
              </div>
              <div className="cr-stat">
                <span className="cr-stat-label">累计消耗</span>
                <b className="cr-stat-value out">−{summary?.totalConsumed ?? 0}</b>
              </div>
              <div className="cr-stat">
                <span className="cr-stat-label">每轮预扣</span>
                <b className="cr-stat-value">{summary?.holdCredits ?? 0}</b>
              </div>
              <div className="cr-stat">
                <span className="cr-stat-label">注册赠送</span>
                <b className="cr-stat-value">{summary?.signupBonus ?? 0}</b>
              </div>
            </div>

            <p className="cr-pricing">
              {summary?.pricingNote ?? '正在读取定价规则…'}
              {!summary?.enforceBalance && '（当前未开启余额闸门：余额为负时仍可继续对话）'}
            </p>

            <div className="row">
              <button className="btn btn-sm" onClick={() => void runReconcile()}>
                核对账本
              </button>
              {reconcile && (
                <span className={`chip${reconcile.consistent ? '' : ' chip-warn'}`}>
                  <span className={`dot ${reconcile.consistent ? 'dot-ok' : 'dot-err'}`} />
                  余额 {reconcile.balance} ｜ 账本累计 {reconcile.ledgerSum} ｜
                  {reconcile.consistent ? ' 一致' : ' 不一致（已记录，请联系支持）'}
                </span>
              )}
            </div>
          </section>

          {/* ---------------------------------------------------------- 套餐 */}
          <section className="cr-section">
            <h2 className="page-h2">
              充值套餐
              <span className="page-h2-note">当前是内置模拟支付通道：点「模拟支付成功」即可完成入账，形状与真实回调一致（可重复调用、不重复到账）</span>
            </h2>

            <div className="cr-plans">
              {plans.map((plan) => (
                <article key={plan.code} className={`cr-plan${plan.tag ? ' featured' : ''}`}>
                  {plan.tag && <span className="cr-plan-tag">{plan.tag}</span>}
                  <div className="cr-plan-name">{plan.name}</div>
                  <div className="cr-plan-price">
                    <span className="cr-plan-amount">{formatYuan(plan.priceCents)}</span>
                  </div>
                  <div className="cr-plan-credits">
                    {plan.totalCredits} 积分
                    {plan.bonusCredits > 0 && <span className="cr-plan-bonus">含赠送 {plan.bonusCredits}</span>}
                  </div>
                  <p className="cr-plan-desc">{plan.description ?? ''}</p>
                  <div className="cr-plan-rate">{plan.centsPerKiloCredit} 分/元 · 每千积分</div>
                  <button
                    className="btn btn-primary"
                    onClick={() => void buy(plan)}
                    disabled={busyPlan !== null}
                    title={`下单购买 ${plan.name}`}
                  >
                    {busyPlan === plan.code && <span className="spinner" />}
                    立即充值
                  </button>
                </article>
              ))}
              {plans.length === 0 && !loading && <p className="cr-empty">暂时没有可购买的套餐。</p>}
            </div>
          </section>

          {/* ---------------------------------------------------------- 订单 */}
          <section className="cr-section">
            <h2 className="page-h2">
              我的订单
              {pendingOrders > 0 && (
                <span className="page-h2-note">有 {pendingOrders} 笔待支付 —— 预支付会话会过期，点「继续支付」会重新取一份凭证</span>
              )}
            </h2>
            {orders.length === 0 ? (
              <p className="cr-empty">还没有订单。上面选一个套餐就能开始。</p>
            ) : (
              <table className="cr-table">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>套餐</th>
                    <th className="num">金额</th>
                    <th className="num">积分</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th className="act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.orderNo}>
                      <td className="mono">{order.orderNo.slice(0, 8)}</td>
                      <td className="mono">{order.planCode}</td>
                      <td className="num">{formatYuan(order.amountCents)}</td>
                      <td className="num">{order.credits}</td>
                      <td>
                        <span className={`cr-status ${order.status.toLowerCase()}`}>
                          {order.status === 'PAID' ? '已支付' : order.status === 'PENDING' ? '待支付' : '已取消'}
                        </span>
                      </td>
                      <td className="mono dim">{formatDateTime(order.createdAt)}</td>
                      <td className="act">
                        {order.status === 'PENDING' && (
                          <div className="row">
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={busyOrder === order.orderNo}
                              onClick={() => void resumePay(order)}
                            >
                              继续支付
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={busyOrder === order.orderNo}
                              onClick={() => void cancelOrder(order.orderNo)}
                            >
                              取消
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---------------------------------------------------------- 流水 */}
          <section className="cr-section">
            <h2 className="page-h2">
              积分流水
              <span className="page-h2-note">
                预扣（HOLD）与结算（SETTLE）是两笔记录，净额才是这一轮的实际花费 —— 多退少补
              </span>
            </h2>

            {ledger && ledger.items.length > 0 ? (
              <>
                <table className="cr-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>类型</th>
                      <th>说明</th>
                      <th className="num">变动</th>
                      <th className="num">变动后余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.items.map((entry) => {
                      const meta = LEDGER_KINDS[entry.kind] ?? { label: entry.kind, tone: 'out' as const };
                      return (
                        <tr key={entry.id}>
                          <td className="mono dim">
                            {formatDateTime(entry.createdAt)}
                          </td>
                          <td>
                            <span className={`cr-kind ${meta.tone}`}>{meta.label}</span>
                          </td>
                          <td className="cr-reason">{entry.reason ?? '—'}</td>
                          <td className={`num delta ${entry.delta >= 0 ? 'in' : 'out'}`}>
                            {formatDelta(entry.delta)}
                          </td>
                          <td className="num">{entry.balanceAfter}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="cr-pager">
                  <button
                    className="btn btn-sm"
                    disabled={offset === 0}
                    onClick={() => void loadLedger(Math.max(0, offset - PAGE_SIZE))}
                  >
                    上一页
                  </button>
                  <span className="cr-pager-info">
                    第 {from}–{to} 条 / 共 {ledger.total} 条
                  </span>
                  <button
                    className="btn btn-sm"
                    disabled={to >= ledger.total}
                    onClick={() => void loadLedger(offset + PAGE_SIZE)}
                  >
                    下一页
                  </button>
                </div>
              </>
            ) : (
              <p className="cr-empty">{loading ? '正在读取流水…' : '还没有任何积分变动。'}</p>
            )}
          </section>
        </div>
      </main>

      {/* ------------------------------------------------------------ 收银台 */}
      {checkout && (
        <div className="modal-backdrop" onClick={() => setCheckout(null)}>
          <div
            className="modal cr-checkout"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label="确认支付"
          >
            <div className="modal-head">
              <CreditIcon size={16} />
              <span className="modal-title">确认支付</span>
              <div className="topbar-spacer" />
              <button className="icon-btn" title="关闭" onClick={() => setCheckout(null)}>
                <CloseIcon size={13} />
              </button>
            </div>

            <div className="modal-body">
              <div className="cr-order-grid">
                <div className="cr-order-cell">
                  <span>订单号</span>
                  <b className="mono">{checkout.order.orderNo}</b>
                </div>
                <div className="cr-order-cell">
                  <span>套餐</span>
                  <b className="mono">{checkout.order.planCode}</b>
                </div>
                <div className="cr-order-cell">
                  <span>金额</span>
                  <b>{formatYuan(checkout.order.amountCents)}</b>
                </div>
                <div className="cr-order-cell">
                  <span>到账积分</span>
                  <b className="in">+{checkout.order.credits}</b>
                </div>
              </div>

              <p className="modal-note">
                {String(checkout.payment.hint ?? '请完成支付。支付成功后积分会立刻到账。')}
              </p>

              <div className="cr-paytoken">
                <span className="cr-paytoken-label">支付凭证 payToken</span>
                <code>{String(checkout.payment.payToken ?? '—')}</code>
              </div>

              <p className="cr-fineprint">
                这个凭证会原样回传给服务端标记订单已支付。真实通道这里是二维码内容或跳转地址，
                回调的形状完全一样。
              </p>
            </div>

            <div className="modal-foot">
              <button className="btn" onClick={() => setCheckout(null)}>
                取消
              </button>
              <div className="topbar-spacer" />
              <button className="btn btn-primary" onClick={() => void confirmPay()} disabled={paying}>
                {paying && <span className="spinner" />}
                {checkout.payment.mock === true ? '模拟支付成功' : '我已支付，确认到账'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
