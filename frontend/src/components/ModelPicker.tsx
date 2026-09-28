import { useEffect, useRef, useState } from 'react';

import { MODEL_TIERS } from '../lib/api';
import type { ModelOption } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * 顶栏的模型选择器。
 *
 * 它接替了原来那颗只「读一眼」的模型状态 chip：现在它同时是三件事——
 *   1. 状态灯（绿点/黄点：模型通不通，沿用健康检查）；
 *   2. 当前用的是哪个模型（名字直接写在 chip 上）；
 *   3. 下拉就能换（每轮对话都可以换，只影响下一轮，不改动你的全局默认）。
 *
 * 「全局默认」在模型服务页里改：那里改的是持久偏好；这里改的是「本轮用谁」。
 * 两者刻意分开 —— 就像WorkBuddy：顶部随时切，设置页存偏好。
 */
export function ModelPicker({ models, currentKey, healthReady, onPick }: {
  /** 模型目录里的全部选项；null 表示还没拉到目录（此时退化为纯状态 chip）。 */
  models: ModelOption[] | null;
  /** 当前选中的模型 key；null = 跟随默认。 */
  currentKey: string | null;
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

  const current = models?.find((m) => m.modelKey === currentKey) ?? null;
  const available = (models ?? []).filter((m) => m.available);
  const label = current ? current.displayName : '默认模型';
  const ready = healthReady && (models === null || available.length > 0);

  return (
    <div className="md-picker" ref={rootRef}>
      <button
        className="chip chip-btn"
        onClick={() => setOpen((v) => !v)}
        title={
          ready
            ? '当前对话模型。点开可以为本轮对话换模型（只影响下一轮）'
            : '模型未就绪 —— 点开看看哪些模型可用，或到模型服务页配置'
        }
      >
        <span className={`dot ${ready ? 'dot-ok' : 'dot-warn'}`} />
        {label}
        {models !== null && <span className="md-picker-caret">▾</span>}
      </button>

      {open && models !== null && (
        <div className="md-picker-menu" role="listbox" aria-label="选择对话模型">
          <div className="md-picker-head">为本轮对话选择模型</div>
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
