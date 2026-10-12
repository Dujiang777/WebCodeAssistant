import { useEffect, useRef, useState } from 'react';

import { MODEL_TIERS } from '../lib/api';
import type { ModelOption } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * 顶栏的模型选择器。
 *
 * 选中的就是账号默认：刷新、换工作区、再进来都还是它。
 * chip 上永远写真实模型名 —— 「默认模型」四个字看不出下一轮会打给谁。
 */
export function ModelPicker({ models, currentKey, defaultKey, healthReady, onPick }: {
  /** 模型目录里的全部选项；null 表示还没拉到目录（此时退化为纯状态 chip）。 */
  models: ModelOption[] | null;
  /** 当前选中的模型 key；null = 跟随默认。 */
  currentKey: string | null;
  /** 账号里记住的默认；currentKey 为空时用它来显示名字。 */
  defaultKey: string | null;
  healthReady: boolean;
  onPick: (modelKey: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击别处关闭；Esc 也能关 —— 下拉是浮层，必须给键盘留出口
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const available = (models ?? []).filter((m) => m.available);
  const effectiveKey = currentKey ?? defaultKey;
  const current = (models ?? []).find((m) => m.modelKey === effectiveKey)
    ?? available.find((m) => !m.byok)
    ?? available[0]
    ?? null;
  const label = current ? current.displayName : '默认模型';
  const ready = healthReady && (models === null || available.length > 0);

  return (
    <div className="md-picker" ref={rootRef}>
      <button
        className="chip chip-btn"
        onClick={() => setOpen((v) => !v)}
        title={
          ready
            ? `当前对话模型：${label}。换了会记住，刷新还是它`
            : '模型未就绪 —— 点开看看哪些模型可用，或到模型服务页配置'
        }
      >
        <span className={`dot ${ready ? 'dot-ok' : 'dot-warn'}`} />
        {label}
        {models !== null && <span className="md-picker-caret">▾</span>}
      </button>

      {open && models !== null && (
        <div className="md-picker-menu" role="listbox" aria-label="选择对话模型">
          <div className="md-picker-head">选择对话模型（会记住）</div>
          <button
            className={`md-picker-item${currentKey === null ? ' on' : ''}`}
            onClick={() => { onPick(null); setOpen(false); }}
          >
            <span className="md-picker-name">跟随默认模型</span>
            <span className="md-picker-price">按全局设置</span>
          </button>
          {available.map((model) => (
            <button
              key={model.modelKey}
              className={`md-picker-item${model.modelKey === currentKey ? ' on' : ''}`}
              onClick={() => { onPick(model.modelKey); setOpen(false); }}
              title={model.note ?? model.displayName}
            >
              <span className="md-picker-name">
                {model.displayName}
                {model.byok && <em className="md-byok-tag">自带</em>}
                <em className={`md-tier-tag md-tier-${(MODEL_TIERS[model.tier] ?? { tone: 'mid' }).tone}`}>
                  {(MODEL_TIERS[model.tier] ?? { label: model.tier }).label}
                </em>
              </span>
              <span className="md-picker-price">
                {model.byok ? '免积分' : `${model.per1kInput}/${model.per1kOutput} 每千`}
              </span>
            </button>
          ))}
          {available.length === 0 && (
            <div className="md-picker-empty">没有可用模型 —— 到模型服务页配置一个，或用平台自带模型。</div>
          )}
          <button className="md-picker-manage" onClick={() => navigate('/models')}>
            模型服务：设默认、配自己的 API Key →
          </button>
        </div>
      )}
    </div>
  );
}
