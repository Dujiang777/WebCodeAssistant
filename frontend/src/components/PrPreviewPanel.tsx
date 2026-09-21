import { useState } from 'react';

import { api } from '../lib/api';
import type { PrPreview } from '../lib/api';
import { DiffIcon } from './icons';

/**
 * 变更预演 PR：把补丁「假如这是一次真实团队协作」的样子预演出来 ——
 * 建议标题 / 分支名、Markdown 正文、审查清单（含宪法状态）。
 *
 * 刻意做成**点开才请求**：预演是一次只读计算，但不该在补丁一出现就抢跑 ——
 * 风险条才是第一眼信息，PR 预演是决定应用之前展开细看的那一层。
 */
export function PrPreviewPanel({ patchId, fileName }: { patchId: string; fileName: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && preview === null && !loading) {
      setLoading(true);
      try {
        setPreview(await api.prPreview(patchId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
  };

  const stateColor: Record<string, string> = {
    ok: 'var(--mint)',
    warn: 'var(--amber)',
    bad: 'var(--rose)',
    info: 'var(--fg-3)',
  };

  return (
    <div className="pr-preview">
      <button className="pr-toggle" onClick={() => void toggle()}>
        <DiffIcon size={12} />
        {open ? '收起 PR 预演' : 'PR 预演'}
        <span className="mono" style={{ color: 'var(--fg-3)' }}>
          {fileName}
        </span>
      </button>

      {open && (
        <div className="pr-body">
          {loading && (
            <div className="loading-block" style={{ padding: '14px 12px' }}>
              <span className="spinner" />
              <span>正在生成 PR 预演…</span>
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
          {preview && (
            <>
              <div className="pr-title mono">{preview.title}</div>
              <div className="pr-branch mono">
                分支建议：<span>{preview.branch}</span>
                <span className="pr-stats">
                  +{preview.stats.addedLines} / -{preview.stats.removedLines} ·{' '}
                  {preview.stats.callers} 处引用 · {preview.stats.testFiles} 个测试文件
                </span>
              </div>

              <div className="pr-checklist">
                <div className="pr-checklist-head">审查清单（应用前逐项过目）</div>
                {preview.checklist.map((item) => (
                  <div key={item.text} className="pr-check" style={{ borderColor: stateColor[item.state] ?? 'var(--line)' }}>
                    <span
                      className="pr-check-state mono"
                      style={{ color: stateColor[item.state] ?? 'var(--fg-3)' }}
                    >
                      {item.state === 'ok'
                        ? 'PASS'
                        : item.state === 'warn'
                          ? 'WARN'
                          : item.state === 'bad'
                            ? 'RISK'
                            : 'NOTE'}
                    </span>
                    <span className="pr-check-text">{item.text}</span>
                    <span className="pr-check-detail">{item.detail}</span>
                  </div>
                ))}
              </div>

              <details className="pr-mdetails">
                <summary className="mono">PR 描述（Markdown，可直接复制进 commit / 平台）</summary>
                <pre className="pr-md mono">{preview.body}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
