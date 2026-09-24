import { useEffect, useMemo, useState } from 'react';

import type { PendingGate } from '../lib/api';
import { CheckIcon, CloseIcon, ShieldIcon } from './icons';

/**
 * 工具级闸门卡片（功能 14）—— 把人机接口从「审 diff」提前到「审意图」。
 *
 * 旧的交互是：Agent 把活干完 → 你看一份已经写好的 diff → 决定要不要。
 * 问题是那一步的 token 已经烧掉了，你也得读一份可能从头就不该写的改动。
 *
 * 现在每次写操作（起草补丁、跑测试）或大范围检索之前，Agent 在服务端挂起，
 * 推来这张卡片。你看到的不是结果，而是**它打算怎么做**：
 *   - 最上面一行是人话版意图（「想在 UserService.java 上生成一个代码补丁」）；
 *   - 下面是它要用的**真实参数**，可以直接改 —— 改完放行，它就用你改过的参数执行；
 *   - 不认同就拦下，模型会收到「已被人拦下」，改用只读手段继续。
 *
 * 一个容易忽略但很关键的实现细节：卡片上参数是**缩写/截断**展示的（例如 diff 只给开头），
 * 所以放行时前端只回传**被人工改过的那些键**。服务端再把它们合进原始参数 ——
 * 否则缩写版会把一份好好的补丁写坏。这件事由后端 changedKeys 兜底。
 *
 * 超时（默认 20s）会自动放行，理由是「给你机会插话」，不是让工作流停摆。
 */
interface GateCardProps {
  gate: PendingGate;
  busy: boolean;
  onApprove: (gateId: string, args: Record<string, unknown>, note: string) => void;
  onReject: (gateId: string, note: string) => void;
}

/** 这些键是「意图的骨架」，改它们才是真的在改这一次调用；其余多为附带信息。 */
const KEY_PARAMS = ['file', 'path', 'pattern', 'glob', 'query', 'command', 'test'];

const PARAM_LABEL: Record<string, string> = {
  file: '目标文件',
  path: '路径',
  pattern: '检索模式',
  glob: '文件过滤',
  query: '检索问题',
  command: '命令',
  test: '测试范围',
  diff: '补丁内容',
  summary: '说明',
  scope: '范围',
};

function labelOf(key: string): string {
  return PARAM_LABEL[key] ?? key;
}

function isKeyParam(key: string): boolean {
  return KEY_PARAMS.includes(key);
}

/** 展示用缩写：长值（diff）只给开头，避免卡片被一屏代码撑爆。 */
function shorten(value: unknown): { text: string; truncated: boolean } {
  if (value === null || value === undefined) return { text: '', truncated: false };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= 260) return { text, truncated: false };
  return { text: text.slice(0, 260), truncated: true };
}

export function GateCard({ gate, busy, onApprove, onReject }: GateCardProps) {
  const [draftArgs, setDraftArgs] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [left, setLeft] = useState(() => Math.max(0, gate.expiresAt - Date.now()));

  // 闸门换了（gateId 变）就重置本地编辑态，否则会把上一个闸门的改动带过来
  useEffect(() => {
    setDraftArgs({});
    setNote('');
    setLeft(Math.max(0, gate.expiresAt - Date.now()));
  }, [gate.gateId, gate.expiresAt]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, gate.expiresAt - Date.now()));
    }, 500);
    return () => window.clearInterval(timer);
  }, [gate.expiresAt]);

  const entries = useMemo(() => {
    const keys = Object.keys(gate.args ?? {});
    return keys.sort((a, b) => Number(isKeyParam(b)) - Number(isKeyParam(a)));
  }, [gate.args]);

  const changedKeys = useMemo(
    () => Object.keys(draftArgs).filter((key) => draftArgs[key] !== shorten(gate.args[key]).text),
    [draftArgs, gate.args],
  );

  const approve = () => {
    const payload: Record<string, unknown> = {};
    for (const key of changedKeys) payload[key] = draftArgs[key];
    onApprove(gate.gateId, payload, note);
  };

  const seconds = Math.ceil(left / 1000);
  const expiring = left > 0 && left < 6000;

  return (
    <div className="gate-card">
      <div className="gate-head">
        <ShieldIcon size={14} />
        <span className="gate-title">已拦下一步</span>
        <span className="gate-tool">{gate.tool}</span>
        <div className="topbar-spacer" />
        <span className={`gate-timer${expiring ? ' expiring' : ''}`} title="超时未处理将自动放行">
          {seconds > 0 ? `${seconds}s 后自动放行` : '超时已放行'}
        </span>
      </div>

      <div className="gate-intent">{gate.intent}</div>
      <div className="gate-reason">{gate.reason}</div>

      <div className="gate-params">
        {entries.length === 0 && <div className="gate-noparams">这一步没有可调参数。</div>}
        {entries.map((key) => {
          const shown = shorten(gate.args[key]);
          const value = draftArgs[key] ?? shown.text;
          const changed = changedKeys.includes(key);
          const long = value.length > 60 || value.includes('\n');
          return (
            <label key={key} className={`gate-param${isKeyParam(key) ? ' key' : ''}${changed ? ' changed' : ''}`}>
              <span className="gate-param-label">
                {labelOf(key)}
                {changed && <span className="gate-param-changed">已改</span>}
              </span>
              {long ? (
                <textarea
                  className="gate-param-input"
                  rows={Math.min(6, Math.max(3, value.split('\n').length))}
                  value={value}
                  onChange={(event) => setDraftArgs((current) => ({ ...current, [key]: event.target.value }))}
                />
              ) : (
                <input
                  className="gate-param-input"
                  value={value}
                  onChange={(event) => setDraftArgs((current) => ({ ...current, [key]: event.target.value }))}
                />
              )}
              {shown.truncated && !changed && (
                <span className="gate-param-note">
                  展示为缩写；不改动这一项时，服务端仍用原始完整值执行。
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="gate-actions">
        <input
          className="gate-note"
          placeholder="备注（拦下时给模型一个理由，它会照做）"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={approve}>
          {busy ? <span className="spinner" /> : <CheckIcon size={12} />}
          {changedKeys.length > 0 ? `用改过的参数放行（${changedKeys.length} 项）` : '放行'}
        </button>
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => onReject(gate.gateId, note)}>
          <CloseIcon size={12} />
          拦下
        </button>
      </div>
    </div>
  );
}
