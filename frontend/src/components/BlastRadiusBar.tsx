import { useState } from 'react';

import type { BlastRadius, RefView, RiskView } from '../lib/api';
import { ShieldIcon } from './icons';

/**
 * 补丁风险条（Blast radius）。
 *
 * 为什么值得占这块地方：只给 diff，用户只能判断「改得对不对」；给不了「敢不敢点应用」。
 * 后者取决于影响面 —— 改的是没人用的私有方法，还是被 14 处调用的鉴权入口，风险差着量级。
 *
 * 所有结论都是提示而非判决：这里从不拦人，只把事实摊开。
 */
interface BlastRadiusBarProps {
  radius: BlastRadius | null;
  loading: boolean;
  error: string | null;
  onOpenRef: (file: string, line: number | null) => void;
}

const LEVEL_TEXT: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const LEVEL_COLOR: Record<string, string> = {
  high: 'var(--rose)',
  medium: 'var(--amber)',
  low: 'var(--fg-3)',
};

export function BlastRadiusBar({ radius, loading, error, onOpenRef }: BlastRadiusBarProps) {
  const [showCallers, setShowCallers] = useState(false);

  if (loading) {
    return (
      <div className="risk-bar">
        <span className="spinner" />
        <span className="risk-headline">正在分析影响面…（搜索谁会受这次改动影响）</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="risk-bar">
        <ShieldIcon size={12} />
        <span className="risk-headline">影响面分析失败：{error}</span>
      </div>
    );
  }

  if (!radius) return null;

  const level = radius.riskLevel ?? 'low';
  const highRisks = radius.risks.filter((risk) => risk.level === 'high');

  return (
    <div className={`risk-bar risk-${level}`}>
      <div className="risk-head">
        <span className="risk-badge" style={{ color: LEVEL_COLOR[level] ?? 'var(--fg-3)' }}>
          风险 {LEVEL_TEXT[level] ?? level}
        </span>
        <span className="risk-headline">{radius.headline}</span>
      </div>

      {radius.risks.length > 0 && (
        <div className="risk-chips">
          {radius.risks.map((risk: RiskView, index: number) => (
            <span
              key={`${risk.label}-${index}`}
              className={`risk-chip risk-chip-${risk.level}`}
              title={risk.reason}
            >
              {risk.label}
            </span>
          ))}
        </div>
      )}

      {highRisks.length > 0 && (
        <div className="risk-reasons">
          {highRisks.map((risk, index) => (
            <div key={index}>
              <b>{risk.label}</b> —— {risk.reason}
            </div>
          ))}
        </div>
      )}

      <div className="risk-foot">
        <button
          className="link-btn"
          onClick={() => setShowCallers((value) => !value)}
          disabled={radius.callers.length === 0}
        >
          {showCallers ? '▾' : '▸'} {radius.callers.length} 处引用
          {radius.callersTruncated ? '（已截断）' : ''}
        </button>

        <span className="risk-sep">·</span>

        <span className="risk-test">
          {radius.tests.length > 0
            ? `${radius.tests.length} 个测试文件覆盖`
            : '没有测试覆盖'}
        </span>

        {radius.changedMembers.length > 0 && (
          <>
            <span className="risk-sep">·</span>
            <span className="risk-members" title={radius.changedMembers.join('、')}>
              触碰 {radius.changedMembers.length} 个成员
            </span>
          </>
        )}
      </div>

      {showCallers && radius.callers.length > 0 && (
        <div className="risk-refs">
          {radius.callers.map((ref: RefView, index: number) => (
            <button
              key={`${ref.file}-${ref.line}-${index}`}
              className="risk-ref"
              title={ref.text}
              onClick={() => onOpenRef(ref.file, ref.line)}
            >
              <span className="risk-ref-file">{ref.file}</span>
              <span className="risk-ref-line">:{ref.line}</span>
              <span className="risk-ref-text">{ref.text.trim()}</span>
            </button>
          ))}
          {radius.tests.length > 0 && (
            <div className="risk-refs-group">测试引用</div>
          )}
          {radius.tests.map((ref: RefView, index: number) => (
            <button
              key={`test-${ref.file}-${ref.line}-${index}`}
              className="risk-ref"
              title={ref.text}
              onClick={() => onOpenRef(ref.file, ref.line)}
            >
              <span className="risk-ref-file">{ref.file}</span>
              <span className="risk-ref-line">:{ref.line}</span>
              <span className="risk-ref-text">{ref.text.trim()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
