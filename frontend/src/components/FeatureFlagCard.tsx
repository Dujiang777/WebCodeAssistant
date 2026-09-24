import type { FlagView } from '../lib/api';
import { ShieldIcon } from './icons';

/**
 * 特性开关强制包裹卡片（功能 16）。
 *
 * 这个功能的出发点是一句工程纪律：**任何行为变化都默认包进一个开关，
 * 并且必须把开关关闭时的旧路径写出来。** 光有开关没有旧路径，等于没有回滚能力 ——
 * 出事的时候你只能 revert，而不是把开关拨回去。
 *
 * 所以应用前这里强制展示两件事，缺一不可：
 *   1. **开关怎么长**：键名、默认值、包裹位置（哪个方法）、配置行；
 *   2. **开与关各自的运行说明**：打开走新路径、关闭走旧路径（旧代码原样保留）。
 *
 * 用户必须勾选「已确认开关关闭时的旧路径」，应用按钮才会解禁；
 * 后端也会独立校验一次（FLAG_ACK_REQUIRED）—— 前端只是提前把话说明白，
 * 真正的守门人在服务端，绕过 UI 直接打接口同样会被挡。
 */
interface FeatureFlagCardProps {
  view: FlagView | null;
  loading: boolean;
  error: string | null;
  acked: boolean;
  onAck: (acked: boolean) => void;
}

/** 不需要开关时也把「为什么不需要」写出来 —— 让规则可见，用户才不会觉得是随机弹窗。 */
export function FeatureFlagCard({ view, loading, error, acked, onAck }: FeatureFlagCardProps) {
  if (loading) {
    return (
      <div className="flag-card">
        <div className="flag-head">
          <ShieldIcon size={13} />
          <span className="flag-title">特性开关</span>
          <span className="flag-checking">
            <span className="spinner" /> 正在分析这个补丁的行为面…
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flag-card">
        <div className="flag-head">
          <ShieldIcon size={13} />
          <span className="flag-title">特性开关</span>
          <span className="flag-reason">无法分析：{error}</span>
        </div>
      </div>
    );
  }

  if (!view) return null;

  if (!view.required) {
    return (
      <div className="flag-card flag-card-ok">
        <div className="flag-head">
          <ShieldIcon size={13} />
          <span className="flag-title">无需特性开关</span>
        </div>
        <div className="flag-reason">{view.reason}</div>
      </div>
    );
  }

  return (
    <div className={`flag-card flag-card-required${acked ? ' acked' : ''}`}>
      <div className="flag-head">
        <ShieldIcon size={13} />
        <span className="flag-title">这个补丁改动了行为 · 必须包进开关</span>
        <span className="flag-key" title="建议的开关键名">
          {view.flagKey}
        </span>
      </div>

      <div className="flag-reason">{view.reason}</div>

      <div className="flag-grid">
        <div className="flag-fact">
          <span className="flag-fact-label">默认值</span>
          <span className="flag-fact-value">{view.defaultValue}</span>
        </div>
        <div className="flag-fact">
          <span className="flag-fact-label">包裹模式</span>
          <span className="flag-fact-value">{view.mode}</span>
        </div>
        <div className="flag-fact">
          <span className="flag-fact-label">包裹位置</span>
          <span className="flag-fact-value">{view.targetMethod ?? '整段新增代码'}</span>
        </div>
        <div className="flag-fact">
          <span className="flag-fact-label">增删行数</span>
          <span className="flag-fact-value">
            <span className="add">+{view.addedLines.length}</span>
            <span className="sep"> / </span>
            <span className="del">-{view.removedLines.length}</span>
          </span>
        </div>
      </div>

      {/* 开 / 关 两种运行说明并排 —— 这是这张卡片存在的理由 */}
      <div className="flag-runbooks">
        <div className="flag-runbook open">
          <div className="flag-runbook-head">
            <span className="flag-switch on" />
            开关打开 · 走新路径
          </div>
          <div className="flag-runbook-body">{view.openRunbook}</div>
        </div>
        <div className="flag-runbook closed">
          <div className="flag-runbook-head">
            <span className="flag-switch off" />
            开关关闭 · 走旧路径
          </div>
          <div className="flag-runbook-body">{view.closedRunbook}</div>
          {view.legacyCode && (
            <pre className="flag-legacy" title="开关关闭时原样保留的旧实现">
              {view.legacyCode}
            </pre>
          )}
        </div>
      </div>

      {view.wrappedSnippet && (
        <details className="flag-snippet">
          <summary>看包裹后的代码骨架</summary>
          <pre>{view.wrappedSnippet}</pre>
        </details>
      )}

      {view.configLine && (
        <div className="flag-config">
          <span className="flag-fact-label">上线时需要加的一行配置</span>
          <pre>{view.configLine}</pre>
        </div>
      )}

      <label className={`flag-ack${acked ? ' on' : ''}`}>
        <input type="checkbox" checked={acked} onChange={(event) => onAck(event.target.checked)} />
        <span>
          我已确认开关关闭时的旧路径仍然可用 —— 出问题能把开关拨回去，而不是只能 revert 代码
        </span>
      </label>

      {view.notice && <div className="flag-notice">{view.notice}</div>}
    </div>
  );
}
