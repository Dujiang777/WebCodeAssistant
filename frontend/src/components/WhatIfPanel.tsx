import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { WhatIfBranch } from '../lib/api';
import { parseUnifiedDiff } from '../lib/diff';
import { CheckIcon, CloseIcon, DiffIcon, PlayIcon, TrashIcon } from './icons';

/**
 * 反事实分支 / What-if 宇宙（功能 15）。
 *
 * 平时的「改一下看看」只有一条路：改主线 → 不满意 → 撤销 / revert。
 * 这里提供第二条路：**在平行宇宙里改**。
 *
 * 一次实验的生命周期：
 *   1. 你写一句反事实设想（「假如改成构造器注入会怎样？」），并指定在哪个文件上试；
 *   2. 服务端把整个工作区拷成一个影子目录，模型**只在影子里**生成并落一份 diff；
 *   3. 这里左右对比：左边主线原文，右边影子里的结果，变更行高亮；
 *   4. 两种结局 —— 丢弃（默认，影子删掉）或采纳（转成主线上的待确认补丁）。
 *
 * 三个刻意的设计：
 *   - **默认不合并**。实验的默认结局是「什么都没发生」，采纳必须显式点；
 *   - **采纳 ≠ 写盘**。采纳只是把改法搬回主线流程的起点，后面照旧要过审查与快照 ——
 *     反事实实验不能变成绕过审查的捷径；
 *   - **改动只发生在影子里**。无论实验怎么折腾，你的工作区在点「采纳」之前一个字节都不会变。
 */
interface WhatIfPanelProps {
  workspaceId: number;
  sessionId: number | null;
  /** 默认实验文件（取当前编辑器打开的文件，省一次选择）。 */
  initialFile: string | null;
  onClose: () => void;
  /** 采纳成功后通知外层刷新补丁列表。 */
  onAdopted: (patchId: string) => void;
  onOpenRef: (file: string, line: number | null) => void;
}

const STATUS_META: Record<string, { label: string; tone: string }> = {
  ready: { label: '推演完成 · 待你决定', tone: 'ready' },
  unavailable: { label: '无法推演', tone: 'unavailable' },
  adopted: { label: '已采纳到主线', tone: 'adopted' },
  discarded: { label: '已丢弃', tone: 'discarded' },
};

/** 从 unified diff 反推「哪几行变了」，用于给左右两栏上高亮。 */
function changedLineSets(diffText: string): { main: Set<number>; shadow: Set<number> } {
  const main = new Set<number>();
  const shadow = new Set<number>();
  const parsed = parseUnifiedDiff(diffText);
  for (const hunk of parsed.hunks) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
    if (!match) continue;
    let oldLine = Number(match[1]); // 1-based
    let newLine = Number(match[2]);
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        main.add(oldLine);
        oldLine += 1;
      } else if (line.kind === 'add') {
        shadow.add(newLine);
        newLine += 1;
      } else {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { main, shadow };
}

export function WhatIfPanel({
  workspaceId,
  sessionId,
  initialFile,
  onClose,
  onAdopted,
  onOpenRef,
}: WhatIfPanelProps) {
  const [branches, setBranches] = useState<WhatIfBranch[]>([]);
  const [current, setCurrent] = useState<WhatIfBranch | null>(null);
  const [question, setQuestion] = useState('');
  const [file, setFile] = useState(initialFile ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.whatIfList(workspaceId);
        if (!cancelled) setBranches(list);
      } catch {
        // 列表失败不影响开新实验
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const ask = async () => {
    const q = question.trim();
    const target = file.trim();
    if (!q || !target || busy || sessionId === null) return;
    setBusy(true);
    setError(null);
    try {
      const branch = await api.whatIfAsk(workspaceId, sessionId, q, target);
      setCurrent(branch);
      setBranches((list) => [branch, ...list.filter((item) => item.id !== branch.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (branch: WhatIfBranch) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.whatIfDiscard(workspaceId, branch.id);
      setBranches((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      if (current?.id === updated.id) setCurrent(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (branch: WhatIfBranch) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.whatIfAdopt(workspaceId, branch.id);
      const updated = await api.whatIfGet(workspaceId, branch.id);
      setBranches((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      setCurrent(updated);
      onAdopted(result.patchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const lines = useMemo(() => changedLineSets(current?.diff ?? ''), [current?.diff]);
  const mainLines = useMemo(() => (current?.mainText ?? '').split('\n'), [current?.mainText]);
  const shadowLines = useMemo(() => (current?.shadowText ?? '').split('\n'), [current?.shadowText]);

  const status = current ? STATUS_META[current.status] ?? { label: current.status, tone: 'ready' } : null;
  const decidable = current !== null && current.status === 'ready';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">平行宇宙 · What-if</span>
          <span className="chip mono">shadow workspace</span>
          {status && <span className={`chip whatif-chip ${status.tone}`}>{status.label}</span>}
          <div className="topbar-spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="banner error">{error}</div>}

          <div className="whatif-setup">
            <div className="whatif-setup-row">
              <span className="whatif-field-label">在哪个文件上做实验</span>
              <input
                className="snapshots-input mono"
                placeholder="例如 src/main/java/com/demo/UserService.java"
                value={file}
                onChange={(event) => setFile(event.target.value)}
              />
            </div>
            <div className="whatif-setup-row">
              <span className="whatif-field-label">反事实设想</span>
              <textarea
                className="whatif-question"
                rows={3}
                placeholder="例如：假如把这个 Service 改成构造器注入，同时把 countActive 换成 Stream 写法，会是什么样子？"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </div>
            <div className="whatif-setup-actions">
              <span className="whatif-hint">
                会另开一份工作区副本（影子目录）在里面推演 —— 你的主线在点「采纳」之前不会被动过一个字节。
              </span>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || !question.trim() || !file.trim() || sessionId === null}
                onClick={() => void ask()}
              >
                {busy ? <span className="spinner" /> : <PlayIcon size={12} />}
                开一个平行宇宙
              </button>
            </div>
          </div>

          {current && (
            <div className="whatif-result">
              <div className="whatif-result-head">
                <span className="whatif-question-echo" title={current.question}>
                  「{current.question}」
                </span>
                <span className="whatif-file mono" title="实验文件">
                  {current.file}
                </span>
                <span className="whatif-stat">
                  <span className="add">+{current.added}</span>
                  <span className="sep"> / </span>
                  <span className="del">-{current.removed}</span>
                </span>
              </div>

              {current.note && <div className="whatif-note">{current.note}</div>}

              {current.status === 'unavailable' ? (
                <div className="banner info">
                  这个设想没法落成一份可校验的 diff（模型没给出可解析的补丁，或目标文件不存在）。
                  把设想写得更具体一点再试，或换个文件。
                </div>
              ) : (
                <div className="whatif-compare">
                  <div className="whatif-col main">
                    <div className="whatif-col-head">
                      <span className="whatif-col-badge">主线 · 现在</span>
                      <span className="whatif-col-count">{mainLines.length} 行</span>
                    </div>
                    <pre className="whatif-code">
                      {mainLines.map((text, index) => (
                        <div
                          key={index}
                          className={`whatif-line${lines.main.has(index + 1) ? ' del' : ''}`}
                        >
                          <span className="whatif-gutter">{index + 1}</span>
                          <span>{text || ' '}</span>
                        </div>
                      ))}
                    </pre>
                  </div>

                  <div className="whatif-col shadow">
                    <div className="whatif-col-head">
                      <span className="whatif-col-badge">平行宇宙 · 推演后</span>
                      <span className="whatif-col-count">{shadowLines.length} 行</span>
                    </div>
                    <pre className="whatif-code">
                      {shadowLines.map((text, index) => (
                        <div
                          key={index}
                          className={`whatif-line${lines.shadow.has(index + 1) ? ' add' : ''}`}
                        >
                          <span className="whatif-gutter">{index + 1}</span>
                          <span>{text || ' '}</span>
                        </div>
                      ))}
                    </pre>
                  </div>
                </div>
              )}

              <div className="whatif-actions">
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenRef(current.file, null)}
                  title="在编辑器里打开这个文件"
                >
                  <DiffIcon size={12} />
                  打开原文件
                </button>
                <div className="topbar-spacer" />
                {decidable && (
                  <>
                    <button className="btn btn-sm" disabled={busy} onClick={() => void discard(current)}>
                      <TrashIcon size={12} />
                      丢弃这个宇宙（默认）
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() => void adopt(current)}
                      title="转成主线上的一条待确认补丁，仍要人工审阅后才能应用"
                    >
                      {busy ? <span className="spinner" /> : <CheckIcon size={12} />}
                      采纳到主线
                    </button>
                  </>
                )}
                {current.status === 'adopted' && (
                  <span className="whatif-adopted-note">
                    已转成主线待确认补丁 —— 去对话流的补丁卡片上审阅后应用。
                  </span>
                )}
              </div>
            </div>
          )}

          {branches.length > 0 && (
            <div className="whatif-history">
              <div className="whatif-history-head">这次会话开过的宇宙</div>
              {branches.map((branch) => {
                const meta = STATUS_META[branch.status] ?? { label: branch.status, tone: 'ready' };
                return (
                  <button
                    key={branch.id}
                    className={`whatif-history-row${current?.id === branch.id ? ' active' : ''}`}
                    onClick={() => setCurrent(branch)}
                  >
                    <span className={`whatif-history-dot ${meta.tone}`} />
                    <span className="whatif-history-q">{branch.question}</span>
                    <span className="whatif-history-file mono">{branch.file}</span>
                    <span className="whatif-history-stat">
                      <span className="add">+{branch.added}</span>
                      <span className="sep">/</span>
                      <span className="del">-{branch.removed}</span>
                    </span>
                    <span className="whatif-history-status">{meta.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-note">
            影子工作区是整仓副本，实验结束即删。采纳只是把改法搬回主线流程的起点，不直接写盘。
          </span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
