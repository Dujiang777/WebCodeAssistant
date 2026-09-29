import { formatDateTime } from '../lib/api';

/**
 * 免费额度进度条 —— 实心段是已用掉的部分，斜纹段是剩下的。
 *
 * 为什么不用普通进度条：额度这个东西的视觉重心应该落在「还剩多少」上，
 * 斜纹（未被填满）天然有「空着」的语义，实心 + 斜纹的分界一眼就是消耗进度，
 * 不用读文字也知道自己烧到哪了。
 *
 * 数据口径：免费额度就是「余额补至注册赠送线」（后端每周懒重置），
 * 所以这里显示的是 balance / signupBonus。充值或管理员加的分数会让
 * 百分比超过 100 的情况被钳制在 100 —— 进度条不该溢出。
 */
export function QuotaBar({
  balance,
  total,
  byok,
  quotaResetAt,
  compact,
}: {
  balance: number;
  total: number;
  byok: boolean;
  quotaResetAt: string | null;
  compact?: boolean;
}) {
  if (byok) {
    return (
      <div className={`quota-bar-row${compact ? ' compact' : ''}`} title="你正在使用自己的 API Key，不消耗平台免费额度">
        <span className="quota-bar-label">自带 Key 模式 · 不消耗免费额度</span>
      </div>
    );
  }
  if (total <= 0) {
    return null;
  }
  const usedRatio = Math.max(0, Math.min(1, 1 - balance / total));
  const percent = Math.round(usedRatio * 100);
  const warn = usedRatio >= 0.9 && usedRatio < 1;
  const exhausted = usedRatio >= 1;
  const resetLabel = quotaResetAt ? ` · ${formatDateTime(quotaResetAt)} 重置` : '';
  return (
    <div
      className={`quota-bar-row${compact ? ' compact' : ''}${exhausted ? ' exhausted' : ''}${warn ? ' warn' : ''}`}
      title={`本周免费额度已用 ${percent}%（余额 ${Math.max(0, balance)} / ${total} 分）${resetLabel}`}
    >
      <div className="quota-bar-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="quota-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="quota-bar-num">{percent}%</span>
      {!compact && (
        <span className="quota-bar-label">
          本周免费额度已用 {percent}%{resetLabel}
        </span>
      )}
    </div>
  );
}
