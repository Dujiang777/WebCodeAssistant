import { useCallback, useEffect, useState } from 'react';

import {
  ADMIN_ACTIONS,
  api,
  formatDateTime,
  formatDelta,
  formatYuan,
  LEDGER_KINDS,
  loadUser,
} from '../lib/api';
import type {
  AdminAuditPage,
  AdminOrderPage,
  AdminStats,
  AdminTrendPoint,
  AdminUserDetail,
  AdminUserPage,
  AdminUserRow,
} from '../lib/api';
import { messageOf } from '../lib/chat';
import { PageBar } from '../components/PageBar';
import { CloseIcon, SearchIcon, ShieldIcon } from '../components/icons';

/**
 * 管理后台：看板 / 用户 / 订单 / 审计。
 *
 * 面向的不是工程师而是「管理员」—— 所以每个动作都要回答三件事：
 *   这个按钮会做什么（按钮旁的人话说明）、做错了能不能救（能：启用/再改回来）、
 *   谁做的什么时候做的（审计页全程留痕，详情抽屉里也能看到这个人被谁动过）。
 *
 * 危险动作一律走「确认模态」，且把后果写进确认文案里
 * （例如停用 = 对方立刻被踢下线，直到重新启用）。
 */

const PAGE_SIZE = 20;
const TREND_DAYS = 14;

type Tab = 'dashboard' | 'users' | 'orders' | 'audit';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'dashboard', label: '看板', hint: '平台现在的样子：多少人、多少钱、今天发生了什么' },
  { key: 'users', label: '用户', hint: '找一个人、看他的一切、必要时进行处理' },
  { key: 'orders', label: '订单', hint: '谁买过积分、哪笔还没付' },
  { key: 'audit', label: '审计', hint: '管理员做过的每一件事，全都留了痕' },
];

/** 状态徽章。颜色语义与全站一致：金=正常，玫红=停用，橙=锁定/待处理。 */
function StatusBadge({ row }: { row: Pick<AdminUserRow, 'status' | 'locked'> }) {
  if (row.status === 'DISABLED') {
    return <span className="ad-badge ad-badge-danger">已停用</span>;
  }
  if (row.locked) {
    return <span className="ad-badge ad-badge-warn">登录锁定</span>;
  }
  return <span className="ad-badge ad-badge-ok">正常</span>;
}

function RoleBadge({ role }: { role: string }) {
  return role === 'ADMIN'
    ? <span className="ad-badge ad-badge-admin"><ShieldIcon size={10} /> 管理员</span>
    : <span className="ad-badge">用户</span>;
}

/* ====================================================================== 看板 */

function Dashboard({ stats, trend }: { stats: AdminStats | null; trend: AdminTrendPoint[] }) {
  const cards: { label: string; value: number; hint: string; tone?: 'ok' | 'warn' | 'bad' }[] = [
    { label: '用户总数', value: stats?.totalUsers ?? 0, hint: '注册过的全部账号' },
    { label: '今日新增', value: stats?.newUsersToday ?? 0, hint: '今天新注册的人数', tone: 'ok' },
    { label: '今日活跃', value: stats?.activeToday ?? 0, hint: '今天至少对话过一轮的人数' },
    { label: '管理员', value: stats?.admins ?? 0, hint: '拥有管理后台权限的账号' },
    { label: '已停用', value: stats?.disabledUsers ?? 0, hint: '被管理员停用、暂时无法登录的账号', tone: 'bad' },
    { label: '锁定中', value: stats?.lockedUsers ?? 0, hint: '连续输错密码被临时锁定的账号', tone: 'warn' },
    { label: '邮箱未验证', value: stats?.unverifiedEmail ?? 0, hint: '还没点过验证邮件的账号' },
    { label: '今日积分消耗', value: stats?.creditsToday ?? 0, hint: '今天所有对话实际花掉的积分', tone: 'ok' },
    { label: '今日对话轮数', value: stats?.turnsToday ?? 0, hint: '今天完成的 AI 对话轮数' },
    { label: '累计发放积分', value: stats?.totalCreditsGranted ?? 0, hint: '注册赠送 + 充值 + 人工调整的总和' },
    { label: '累计消耗积分', value: stats?.totalCreditsConsumed ?? 0, hint: '历史上全部对话的实际花费' },
    { label: '待支付订单', value: stats?.pendingOrders ?? 0, hint: '下了单还没付款的订单', tone: 'warn' },
  ];
  return (
    <div className="ad-dash">
      <div className="ad-stat-grid">
        {cards.map((card, index) => (
          <div
            key={card.label}
            className={`ad-stat-card${card.tone ? ` tone-${card.tone}` : ''}`}
            style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
          >
            <span className="ad-stat-value">{card.value.toLocaleString()}</span>
            <span className="ad-stat-label">{card.label}</span>
            <span className="ad-stat-hint">{card.hint}</span>
          </div>
        ))}
      </div>

      <section className="ad-panel">
        <h2 className="page-h2">
          近 {TREND_DAYS} 天走势
          <span className="page-h2-note">每天新注册的人数（金）与当天积分消耗（浅）</span>
        </h2>
        {trend.length === 0 ? (
          <p className="cr-empty">还没有数据。</p>
        ) : (
          <TrendChart trend={trend} />
        )}
      </section>
    </div>
  );
}

/** 纯 SVG 双系列柱状图：不引图表库，两个系列足够表达「注册」与「消耗」。 */
function TrendChart({ trend }: { trend: AdminTrendPoint[] }) {
  const width = 720;
  const height = 180;
  const pad = { top: 14, bottom: 26, left: 8, right: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...trend.map((p) => Math.max(p.signups, p.credits)));
  const step = innerW / Math.max(trend.length, 1);
  const barW = Math.min(14, step * 0.32);

  return (
    <div className="ad-trend">
      <svg viewBox={`0 0 ${width} ${height}`} className="ad-trend-svg" role="img" aria-label="注册与消耗走势图">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + innerH * (1 - ratio)}
            y2={pad.top + innerH * (1 - ratio)}
            className="ad-trend-grid"
          />
        ))}
        {trend.map((point, index) => {
          const cx = pad.left + step * index + step / 2;
          const hSignup = (point.signups / max) * innerH;
          const hCredits = (point.credits / max) * innerH;
          const label = point.day.slice(5); // MM-dd
          return (
            <g key={point.day}>
              <rect
                x={cx - barW - 2}
                y={pad.top + innerH - hSignup}
                width={barW}
                height={Math.max(hSignup, point.signups > 0 ? 2 : 0)}
                rx={3}
                className="ad-trend-bar ad-trend-signup"
              >
                <title>{`${point.day}：新注册 ${point.signups} 人`}</title>
              </rect>
              <rect
                x={cx + 2}
                y={pad.top + innerH - hCredits}
                width={barW}
                height={Math.max(hCredits, point.credits > 0 ? 2 : 0)}
                rx={3}
                className="ad-trend-bar ad-trend-credits"
              >
                <title>{`${point.day}：消耗 ${point.credits} 积分`}</title>
              </rect>
              {(trend.length <= 10 || index % 2 === 0) && (
                <text x={cx} y={height - 8} textAnchor="middle" className="ad-trend-label">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ad-trend-legend">
        <span><i className="ad-legend-dot signup" /> 新注册</span>
        <span><i className="ad-legend-dot credits" /> 积分消耗</span>
      </div>
    </div>
  );
}

/* ====================================================================== 用户 */

interface UserFilter {
  keyword: string;
  role: string;
  status: string;
  sort: string;
  page: number;
}

const SORTS: { value: string; label: string }[] = [
  { value: 'created_desc', label: '最近注册' },
  { value: 'last_login_desc', label: '最近登录' },
  { value: 'balance_desc', label: '积分最多' },
  { value: 'consumed_desc', label: '消耗最多' },
  { value: 'username_asc', label: '用户名 A→Z' },
];

function UsersTab({ onOpen, reloadKey }: { onOpen: (row: AdminUserRow) => void; reloadKey: number }) {
  const [filter, setFilter] = useState<UserFilter>({ keyword: '', role: '', status: '', sort: 'created_desc', page: 1 });
  const [page, setPage] = useState<AdminUserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async (f: UserFilter) => {
    setLoading(true);
    setError(null);
    try {
      setPage(await api.adminUsers({
        keyword: f.keyword || undefined,
        role: f.role || undefined,
        status: f.status || undefined,
        sort: f.sort,
        page: f.page,
        size: PAGE_SIZE,
      }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, reloadKey]);

  const from = page && page.total > 0 ? (page.page - 1) * page.size + 1 : 0;
  const to = page ? Math.min(page.page * page.size, page.total) : 0;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.size)) : 1;

  return (
    <div className="ad-tab-body">
      <div className="ad-toolbar">
        <form
          className="ad-search"
          onSubmit={(event) => {
            event.preventDefault();
            setFilter((f) => ({ ...f, keyword: search.trim(), page: 1 }));
          }}
        >
          <SearchIcon size={13} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜用户名或邮箱…"
            aria-label="搜索用户"
          />
        </form>
        <select
          className="ad-select"
          value={filter.role}
          onChange={(event) => setFilter((f) => ({ ...f, role: event.target.value, page: 1 }))}
          aria-label="按角色筛选"
        >
          <option value="">全部角色</option>
          <option value="ADMIN">管理员</option>
          <option value="USER">用户</option>
        </select>
        <select
          className="ad-select"
          value={filter.status}
          onChange={(event) => setFilter((f) => ({ ...f, status: event.target.value, page: 1 }))}
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          <option value="ACTIVE">正常</option>
          <option value="DISABLED">已停用</option>
        </select>
        <select
          className="ad-select"
          value={filter.sort}
          onChange={(event) => setFilter((f) => ({ ...f, sort: event.target.value, page: 1 }))}
          aria-label="排序方式"
        >
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>{sort.label}</option>
          ))}
        </select>
        {filter.keyword && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setSearch('');
              setFilter((f) => ({ ...f, keyword: '', page: 1 }));
            }}
          >
            清除搜索
          </button>
        )}
        <span className="ad-toolbar-count">{loading ? '读取中…' : `共 ${page?.total ?? 0} 人`}</span>
      </div>

      {error && <div className="form-error">{error}</div>}

      <table className="cr-table ad-table">
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th>状态</th>
            <th className="num">余额</th>
            <th className="num">累计消耗</th>
            <th>最近登录</th>
            <th className="act">操作</th>
          </tr>
        </thead>
        <tbody>
          {(page?.items ?? []).map((row, index) => (
            <tr key={row.id} style={{ animationDelay: `${Math.min(index * 25, 300)}ms` }}>
              <td>
                <button className="ad-user-cell" onClick={() => onOpen(row)} title="查看详情与处置动作">
                  <b>{row.username}</b>
                  <span className="dim">{row.email ?? '未绑定邮箱'}</span>
                </button>
              </td>
              <td><RoleBadge role={row.role} /></td>
              <td><StatusBadge row={row} /></td>
              <td className="num">{row.balance.toLocaleString()}</td>
              <td className="num dim">{row.totalConsumed.toLocaleString()}</td>
              <td className="mono dim">{row.lastLoginAt ? formatDateTime(row.lastLoginAt) : '从未登录'}</td>
              <td className="act">
                <button className="btn btn-sm" onClick={() => onOpen(row)}>详情</button>
              </td>
            </tr>
          ))}
          {!loading && (page?.items.length ?? 0) === 0 && (
            <tr><td colSpan={7} className="cr-empty">没有符合条件的用户。</td></tr>
          )}
        </tbody>
      </table>

      <div className="cr-pager">
        <button
          className="btn btn-sm"
          disabled={filter.page <= 1}
          onClick={() => setFilter((f) => ({ ...f, page: f.page - 1 }))}
        >
          上一页
        </button>
        <span className="cr-pager-info">第 {from}–{to} 人 / 共 {page?.total ?? 0} 人</span>
        <button
          className="btn btn-sm"
          disabled={filter.page >= totalPages}
          onClick={() => setFilter((f) => ({ ...f, page: f.page + 1 }))}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/* ====================================================================== 详情抽屉 */

interface DrawerState {
  detail: AdminUserDetail;
  actions: (row: AdminUserRow) => void;
  reload: () => void;
}

function UserDrawer({ detail, actions }: DrawerState) {
  const row = detail.user;
  return (
    <div className="ad-drawer">
      <div className="ad-drawer-head">
        <div>
          <div className="ad-drawer-title">
            {row.username}
            <RoleBadge role={row.role} />
            <StatusBadge row={row} />
          </div>
          <div className="dim">{row.email ?? '未绑定邮箱'}{row.emailVerified ? ' · 已验证' : ' · 未验证'}</div>
        </div>
        <div className="ad-drawer-balance">
          <span className="ad-drawer-balance-label">当前余额</span>
          <b>{row.balance.toLocaleString()}</b>
        </div>
      </div>

      {row.status === 'DISABLED' && row.disabledReason && (
        <div className="banner banner-credit">
          <span className="dot dot-err" />
          <span className="banner-text">停用原因：{row.disabledReason}</span>
        </div>
      )}

      <div className="ad-drawer-meta">
        <span>注册于 {formatDateTime(row.createdAt)}</span>
        <span>最近登录 {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : '从未'}</span>
        <span>累计获得 {row.totalGranted.toLocaleString()} · 消耗 {row.totalConsumed.toLocaleString()}</span>
      </div>

      <section className="ad-drawer-section">
        <h3>最近积分流水</h3>
        {detail.ledger.length === 0 ? (
          <p className="cr-empty">没有流水。</p>
        ) : (
          <table className="cr-table ad-mini-table">
            <tbody>
              {detail.ledger.map((entry) => {
                const meta = LEDGER_KINDS[entry.kind] ?? { label: entry.kind, tone: 'out' as const };
                return (
                  <tr key={entry.id}>
                    <td className="mono dim">{formatDateTime(entry.createdAt)}</td>
                    <td><span className={`cr-kind ${meta.tone}`}>{meta.label}</span></td>
                    <td className={`num delta ${entry.delta >= 0 ? 'in' : 'out'}`}>{formatDelta(entry.delta)}</td>
                    <td className="num dim">{entry.balanceAfter}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="ad-drawer-section">
        <h3>在线会话（{detail.sessions.length}）</h3>
        {detail.sessions.length === 0 ? (
          <p className="cr-empty">当前没有活跃登录。</p>
        ) : (
          <ul className="ad-session-list">
            {detail.sessions.map((session) => (
              <li key={session.id}>
                <span className="ad-session-device">{session.device || '未知设备'}</span>
                <span className="mono dim">{session.ip}</span>
                <span className="dim">登录于 {formatDateTime(session.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ad-drawer-section">
        <h3>这个用户被谁动过</h3>
        {detail.audit.length === 0 ? (
          <p className="cr-empty">还没有被处置过。</p>
        ) : (
          <ul className="ad-audit-mini">
            {detail.audit.map((item) => (
              <li key={item.id}>
                <b>{ADMIN_ACTIONS[item.action] ?? item.action}</b>
                <span className="dim">—— {item.operatorName} · {formatDateTime(item.createdAt)}</span>
                {item.detail && <p className="ad-audit-detail">{item.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ad-drawer-foot">
        <button className="btn btn-primary" onClick={() => actions(row)}>
          处置动作
        </button>
      </div>
    </div>
  );
}

/* ====================================================================== 处置模态 */

type ActionKind = 'disable' | 'enable' | 'unlock' | 'promote' | 'demote' | 'resetPassword' | 'revoke' | 'adjust';

interface ActionModal {
  kind: ActionKind;
  row: AdminUserRow;
}

const ACTION_META: Record<ActionKind, { title: string; confirm: string; hint: string; danger?: boolean }> = {
  disable: {
    title: '停用账号',
    confirm: '确认停用',
    hint: '停用后这个人会立刻被踢下线、无法登录，直到被重新启用。他手上的积分和数据都会保留。',
    danger: true,
  },
  enable: {
    title: '启用账号',
    confirm: '确认启用',
    hint: '启用后这个人可以正常登录，历史数据不受影响。',
  },
  unlock: {
    title: '解除登录锁定',
    confirm: '确认解锁',
    hint: '连续输错密码会临时锁定。解锁后可以立即再试，不需要等倒计时。',
  },
  promote: {
    title: '提升为管理员',
    confirm: '确认提升',
    hint: '管理员可以进入管理后台、处理用户与订单。请只给真正需要的人。',
    danger: true,
  },
  demote: {
    title: '降权为普通用户',
    confirm: '确认降权',
    hint: '降权后立即失去管理后台权限，所有登录状态同时作废。',
    danger: true,
  },
  resetPassword: {
    title: '重置密码',
    confirm: '生成临时密码',
    hint: '系统会生成一个 12 位临时密码，只在下一步显示一次。这个人的所有登录会被立即踢下线。',
    danger: true,
  },
  revoke: {
    title: '强制下线',
    confirm: '全部下线',
    hint: '把这个人所有设备上的登录状态立即作废。数据不受影响，他重新登录即可。',
    danger: true,
  },
  adjust: {
    title: '调整积分',
    confirm: '确认调整',
    hint: '正数加、负数减。会记入审计，写清理由方便以后核对。',
  },
};

function ActionDialog({ modal, onClose, onDone }: {
  modal: ActionModal;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const meta = ACTION_META[modal.kind];
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = modal.row;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      switch (modal.kind) {
        case 'disable': {
          if (!reason.trim()) {
            setError('停用必须填写原因 —— 客服要据此回答用户');
            setBusy(false);
            return;
          }
          await api.adminSetStatus(row.id, 'DISABLED', reason.trim());
          onDone(`已停用 ${row.username}，对方的所有登录已立即失效。`);
          break;
        }
        case 'enable':
          await api.adminSetStatus(row.id, 'ACTIVE');
          onDone(`已启用 ${row.username}，现在可以正常登录了。`);
          break;
        case 'unlock':
          await api.adminUnlock(row.id);
          onDone(`已解除 ${row.username} 的登录锁定。`);
          break;
        case 'promote':
          await api.adminSetRole(row.id, 'ADMIN');
          onDone(`${row.username} 已成为管理员。`);
          break;
        case 'demote':
          await api.adminSetRole(row.id, 'USER');
          onDone(`${row.username} 已降权为普通用户，管理权限立即失效。`);
          break;
        case 'resetPassword': {
          const result = await api.adminResetPassword(row.id);
          onDone(`__TEMP__${result.temporaryPassword}__${row.username}`);
          break;
        }
        case 'revoke': {
          const result = await api.adminRevokeSessions(row.id);
          onDone(`已把 ${row.username} 的 ${result.count} 个会话全部下线。`);
          break;
        }
        case 'adjust': {
          const value = Number(amount);
          if (!Number.isInteger(value) || value === 0) {
            setError('请输入非零整数（正数加、负数减）');
            setBusy(false);
            return;
          }
          if (value < 0 && !reason.trim()) {
            setError('扣减积分必须填写理由');
            setBusy(false);
            return;
          }
          const result = await api.adminAdjustCredits(row.id, value, reason.trim() || undefined);
          onDone(
            result.consistent
              ? `已调整 ${row.username} 的积分 ${formatDelta(value)}，当前余额 ${result.balance}（账本已核对一致）。`
              : `积分已调整，但账本出现不一致（余额 ${result.balance} / 账本 ${result.ledgerSum}），请留意。`,
          );
          break;
        }
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ad-modal${meta.danger ? ' ad-modal-danger' : ''}`} onClick={(event) => event.stopPropagation()} role="dialog" aria-label={meta.title}>
        <div className="modal-head">
          <ShieldIcon size={15} />
          <span className="modal-title">{meta.title} · {row.username}</span>
          <div className="topbar-spacer" />
          <button className="icon-btn" title="关闭" onClick={onClose}><CloseIcon size={13} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-note">{meta.hint}</p>

          {modal.kind === 'adjust' && (
            <div className="form-stack">
              <label className="ad-field">
                <span>变动数量（正数加、负数减）</span>
                <input
                  type="number"
                  step={1}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  autoFocus
                />
              </label>
              <label className="ad-field">
                <span>理由{amount.startsWith('-') ? '（扣减必填）' : '（选填）'}</span>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="例如：活动补偿 / 差错修正"
                />
              </label>
            </div>
          )}

          {modal.kind === 'disable' && (
            <label className="ad-field">
              <span>停用原因（必填，会展示在对方的详情里）</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：涉嫌违规使用 / 用户本人申请"
                autoFocus
              />
            </label>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <div className="topbar-spacer" />
          <button
            className={`btn btn-primary${meta.danger ? ' btn-danger' : ''}`}
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy && <span className="spinner" />}
            {meta.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== 订单 / 审计 */

function OrdersTab({ reloadKey }: { reloadKey: number }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminOrderPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.adminOrders({ status: status || undefined, page, size: PAGE_SIZE }));
    } catch (err) {
      setError(messageOf(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const cancel = async (orderNo: string) => {
    setBusy(orderNo);
    setError(null);
    setNotice(null);
    try {
      await api.adminCancelOrder(orderNo);
      setNotice(`订单 ${orderNo.slice(0, 8)}… 已撤销。`);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <div className="ad-tab-body">
      <div className="ad-toolbar">
        <select
          className="ad-select"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          aria-label="按状态筛选订单"
        >
          <option value="">全部状态</option>
          <option value="PENDING">待支付</option>
          <option value="PAID">已支付</option>
          <option value="CANCELLED">已取消</option>
        </select>
        <span className="ad-toolbar-count">{`共 ${data?.total ?? 0} 笔`}</span>
      </div>

      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      <table className="cr-table ad-table">
        <thead>
          <tr>
            <th>订单号</th>
            <th>用户</th>
            <th>套餐</th>
            <th className="num">金额</th>
            <th className="num">积分</th>
            <th>状态</th>
            <th>时间</th>
            <th className="act">操作</th>
          </tr>
        </thead>
        <tbody>
          {(data?.items ?? []).map((order) => (
            <tr key={order.orderNo}>
              <td className="mono">{order.orderNo.slice(0, 10)}</td>
              <td>{order.username}</td>
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
                  <button
                    className="btn btn-sm"
                    disabled={busy === order.orderNo}
                    title="只允许撤销待支付订单。已支付的订单要走退款流程。"
                    onClick={() => void cancel(order.orderNo)}
                  >
                    撤销
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!error && (data?.items.length ?? 0) === 0 && (
            <tr><td colSpan={8} className="cr-empty">没有符合条件的订单。</td></tr>
          )}
        </tbody>
      </table>

      <div className="cr-pager">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span className="cr-pager-info">第 {page} / {totalPages} 页</span>
        <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
      </div>
    </div>
  );
}

function AuditTab({ reloadKey }: { reloadKey: number }) {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminAuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.adminAudit({ action: action || undefined, page, size: PAGE_SIZE }));
    } catch (err) {
      setError(messageOf(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, page]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <div className="ad-tab-body">
      <div className="ad-toolbar">
        <select
          className="ad-select"
          value={action}
          onChange={(event) => { setAction(event.target.value); setPage(1); }}
          aria-label="按动作筛选审计"
        >
          <option value="">全部动作</option>
          {Object.entries(ADMIN_ACTIONS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <span className="ad-toolbar-count">{`共 ${data?.total ?? 0} 条`}</span>
      </div>

      {error && <div className="form-error">{error}</div>}

      <ul className="ad-audit-list">
        {(data?.items ?? []).map((item, index) => (
          <li key={item.id} className="ad-audit-item" style={{ animationDelay: `${Math.min(index * 20, 240)}ms` }}>
            <span className={`ad-badge${item.detail && item.detail.includes('停用') ? ' ad-badge-danger' : ''}`}>
              {ADMIN_ACTIONS[item.action] ?? item.action}
            </span>
            <div className="ad-audit-body">
              <div>
                <b>{item.operatorName}</b>
                <span className="dim">
                  {' '}对 <b>{item.targetName ?? item.targetId}</b>
                  {item.targetType === 'ORDER' ? '（订单）' : ''}
                </span>
              </div>
              {item.detail && <p className="ad-audit-detail">{item.detail}</p>}
            </div>
            <span className="mono dim ad-audit-time">{formatDateTime(item.createdAt)}</span>
          </li>
        ))}
        {!error && (data?.items.length ?? 0) === 0 && <li className="cr-empty">还没有审计记录。</li>}
      </ul>

      <div className="cr-pager">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span className="cr-pager-info">第 {page} / {totalPages} 页</span>
        <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
      </div>
    </div>
  );
}

/* ====================================================================== 页面骨架 */

export function AdminPage({ initialTab, onBack, onLogout }: {
  initialTab: string;
  onBack: () => void;
  onLogout: () => void;
}) {
  const user = loadUser();
  const [tab, setTab] = useState<Tab>(
    ['dashboard', 'users', 'orders', 'audit'].includes(initialTab) ? (initialTab as Tab) : 'dashboard',
  );
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [trend, setTrend] = useState<AdminTrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [drawer, setDrawer] = useState<AdminUserDetail | null>(null);
  const [drawerRow, setDrawerRow] = useState<AdminUserRow | null>(null);
  const [actionModal, setActionModal] = useState<ActionModal | null>(null);
  const [tempPassword, setTempPassword] = useState<{ password: string; username: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadOverview = useCallback(async () => {
    setError(null);
    try {
      const [statData, trendData] = await Promise.all([api.adminStats(), api.adminTrend(TREND_DAYS)]);
      setStats(statData);
      setTrend(trendData);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    if (tab === 'dashboard') void loadOverview();
  }, [tab, reloadKey, loadOverview]);

  const openDetail = async (row: AdminUserRow) => {
    setError(null);
    try {
      setDrawerRow(row);
      setDrawer(await api.adminUserDetail(row.id));
    } catch (err) {
      setError(messageOf(err));
    }
  };

  /** 详情抽屉里「处置动作」打开后，抽屉内容用最新的一行数据刷新。 */
  const refreshDrawer = async (userId: number) => {
    try {
      setDrawer(await api.adminUserDetail(userId));
    } catch {
      setDrawer(null);
    }
  };

  const openActions = (row: AdminUserRow) => {
    setDrawer(null);
    setActionModal({ kind: row.status === 'DISABLED' ? 'enable' : 'disable', row });
  };

  const handleActionDone = async (noticeText: string) => {
    const tempMatch = noticeText.startsWith('__TEMP__')
      ? /^__TEMP__(.+?)__(.+)$/.exec(noticeText)
      : null;
    setActionModal(null);
    setReloadKey((key) => key + 1);
    if (tempMatch) {
      setTempPassword({ password: tempMatch[1], username: tempMatch[2] });
      return;
    }
    setNotice(noticeText);
    if (drawerRow) await refreshDrawer(drawerRow.id);
  };

  return (
    <div className="page">
      <PageBar
        title="管理后台"
        subtitle={user?.username ?? ''}
        balance={null}
        lowBalance={false}
        active="admin"
        isAdmin
        onBack={onBack}
        onLogout={onLogout}
      />

      <nav className="ad-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={`ad-tab${tab === item.key ? ' active' : ''}`}
            onClick={() => { setTab(item.key); setNotice(null); }}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
        <span className="ad-tabs-hint">{TABS.find((item) => item.key === tab)?.hint}</span>
      </nav>

      <main className="page-scroll">
        <div className="page-wrap">
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}

          {tab === 'dashboard' && <Dashboard stats={stats} trend={trend} />}

          {tab === 'users' && (
            <UsersTab
              reloadKey={reloadKey}
              onOpen={(row) => void openDetail(row)}
            />
          )}

          {tab === 'orders' && <OrdersTab reloadKey={reloadKey} />}
          {tab === 'audit' && <AuditTab reloadKey={reloadKey} />}
        </div>
      </main>

      {/* 详情抽屉 */}
      {drawer && drawerRow && (
        <div className="ad-drawer-backdrop" onClick={() => setDrawer(null)}>
          <aside className="ad-drawer-panel" onClick={(event) => event.stopPropagation()}>
            <div className="ad-drawer-close">
              <button className="icon-btn" title="关闭" onClick={() => setDrawer(null)}>
                <CloseIcon size={14} />
              </button>
            </div>
            <UserDrawer detail={drawer} actions={openActions} reload={() => undefined} />
          </aside>
        </div>
      )}

      {/* 处置动作选择 / 确认 */}
      {actionModal && (
        <ActionDialog
          modal={actionModal}
          onClose={() => setActionModal(null)}
          onDone={(text) => void handleActionDone(text)}
        />
      )}

      {/* 临时密码一次性展示 */}
      {tempPassword && (
        <div className="modal-backdrop" onClick={() => setTempPassword(null)}>
          <div className="modal ad-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="临时密码">
            <div className="modal-head">
              <ShieldIcon size={15} />
              <span className="modal-title">临时密码已生成</span>
              <div className="topbar-spacer" />
              <button className="icon-btn" title="关闭" onClick={() => setTempPassword(null)}><CloseIcon size={13} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                请把下面的临时密码当面或通过安全渠道交给 <b>{tempPassword.username}</b>。
                它<b>只显示这一次</b>，不会被保存；对方下次登录后应尽快改成自己的密码。
              </p>
              <div className="ad-temp-password">
                <code>{tempPassword.password}</code>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(tempPassword.password).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1600);
                    });
                  }}
                >
                  {copied ? '已复制 ✓' : '复制'}
                </button>
              </div>
            </div>
            <div className="modal-foot">
              <div className="topbar-spacer" />
              <button className="btn btn-primary" onClick={() => setTempPassword(null)}>我已保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
