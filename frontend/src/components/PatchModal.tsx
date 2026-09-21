import { useEffect, useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';

import { api } from '../lib/api';
import type { PatchRecord } from '../lib/api';
import { applyDiffToText, parseUnifiedDiff } from '../lib/diff';
import { DIFF_OPTIONS, WCA_THEME } from '../lib/monaco';
import { messageOf } from '../lib/chat';
import { CheckIcon, CloseIcon } from './icons';

/**
 * 全屏差异对比。
 *
 * 左侧是「磁盘上的当前内容」，右侧是「应用这个补丁之后的内容」——
 * 右侧不是让模型重新描述一遍，而是<b>用同一份 diff 在前端算出结果</b>，
 * 这样看到的预览与后端 apply 的算法同源，所见即所得。
 *
 * 打开时才去取原文件（而不是预先缓存）：可能是几 MB 的大文件，
 * 没必要为了一个可能不会打开的弹层一直占着内存。
 */
interface PatchModalProps {
  workspaceId: number;
  patch: PatchRecord;
  busy: boolean;
  onClose: () => void;
  onApply: (patch: PatchRecord) => void;
}

export function PatchModal({ workspaceId, patch, busy, onClose, onApply }: PatchModalProps) {
  const [original, setOriginal] = useState<string | null>(null);
  const [language, setLanguage] = useState('plaintext');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const content = await api.readFile(workspaceId, patch.file);
        if (cancelled) return;
        setLanguage(content.language || 'plaintext');
        setOriginal(content.content ?? '');
      } catch {
        if (cancelled) return;
        // 新建文件的补丁取不到原文件，这是正常路径：左右对比就是「空 → 新内容」
        setOriginal('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, patch.file]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 预览结果与错误都在纯计算里得出，不在渲染期间调用 setState
  const computed = useMemo(() => {
    if (original === null) return { text: '', error: null as string | null };
    try {
      return { text: applyDiffToText(original, patch.diff), error: null as string | null };
    } catch (err) {
      return { text: original, error: messageOf(err) };
    }
  }, [original, patch.diff]);

  const shownError = computed.error;
  const modified = computed.text;
  const parsed = useMemo(() => parseUnifiedDiff(patch.diff), [patch.diff]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">完整对比</span>
          <span className="chip mono">{patch.file}</span>
          <span className="patch-stat" style={{ marginLeft: 4 }}>
            <span className="add">+{parsed.added}</span>
            <span style={{ color: 'var(--fg-3)' }}> / </span>
            <span className="del">-{parsed.removed}</span>
          </span>

          <div className="topbar-spacer" />

          {shownError && <span style={{ color: 'var(--rose)', fontSize: 12 }}>{shownError}</span>}
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="modal-body">
          {original === null ? (
            <div className="loading-block" style={{ padding: '20px 16px' }}>
              <span className="spinner" />
              <span>正在读取原文件…</span>
            </div>
          ) : (
            <DiffEditor
              original={original}
              modified={modified}
              language={language}
              theme={WCA_THEME}
              options={DIFF_OPTIONS as unknown as Monaco.editor.IDiffEditorConstructionOptions}
              loading={
                <div className="loading-block" style={{ padding: '20px 16px' }}>
                  <span className="spinner" />
                  <span>正在渲染差异视图…</span>
                </div>
              }
            />
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-note">
            应用后文件会被真的改写；写入前后端会再校验一次能否干净应用。
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || original === null || patch.status !== 'pending'}
            onClick={() => onApply(patch)}
          >
            {busy ? <span className="spinner" /> : <CheckIcon size={13} />}
            {patch.status === 'pending' ? '应用并写盘' : '该补丁已处理'}
          </button>
        </div>
      </div>
    </div>
  );
}
