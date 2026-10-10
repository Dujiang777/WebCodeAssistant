import { useEffect, useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';

import { api } from '../lib/api';
import type { PatchRecord } from '../lib/api';
import { applyDiffToText, parseUnifiedDiff } from '../lib/diff';
import { DIFF_OPTIONS, WCA_THEME } from '../lib/monaco';
import { messageOf } from '../lib/chat';
import type { DiffAskKind } from '../lib/follow';
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
  /** 点某一行之后：解释 / 改 / 谁在用。 */
  onAskLine?: (ask: {
    file: string;
    line: number;
    side: 'original' | 'modified';
    text: string;
    kind: DiffAskKind;
  }) => void;
}

interface PickedLine {
  side: 'original' | 'modified';
  line: number;
  text: string;
}

export function PatchModal({ workspaceId, patch, busy, onClose, onApply, onAskLine }: PatchModalProps) {
  const [original, setOriginal] = useState<string | null>(null);
  const [language, setLanguage] = useState('plaintext');
  const [picked, setPicked] = useState<PickedLine | null>(null);

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

  const isNewFile = original === '';

  useEffect(() => {
    setPicked(null);
  }, [patch.id]);

  const ask = (kind: DiffAskKind) => {
    if (!picked || !onAskLine) return;
    onAskLine({
      file: patch.file,
      line: picked.line,
      side: picked.side,
      text: picked.text,
      kind,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-diff" onClick={(event) => event.stopPropagation()}>
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

        <div className="diff-pane-labels">
          <span>{isNewFile ? '磁盘上现在（还没有这个文件）' : '磁盘上现在'}</span>
          <span>应用之后（先预览，未写盘）</span>
        </div>

        {isNewFile && (
          <div className="banner">
            <span className="dot dot-ok" />
            这是新建文件。左边是空的，右边是点「应用」后会写到磁盘上的内容。
          </div>
        )}

        <div className="modal-body modal-body-diff">
          {original === null ? (
            <div className="loading-block" style={{ padding: '20px 16px' }}>
              <span className="spinner" />
              <span>正在读取原文件…</span>
            </div>
          ) : (
            <DiffEditor
              height="100%"
              original={original}
              modified={modified}
              language={language}
              theme={WCA_THEME}
              options={DIFF_OPTIONS as unknown as Monaco.editor.IDiffEditorConstructionOptions}
              onMount={(editor) => {
                window.requestAnimationFrame(() => editor.layout());
                if (!onAskLine) return;
                const bind = (side: PickedLine['side'], pane: Monaco.editor.IStandaloneCodeEditor) => {
                  pane.onMouseDown((event) => {
                    const pos = event.target.position;
                    if (!pos) return;
                    const text = pane.getModel()?.getLineContent(pos.lineNumber) ?? '';
                    setPicked({ side, line: pos.lineNumber, text });
                  });
                };
                bind('original', editor.getOriginalEditor());
                bind('modified', editor.getModifiedEditor());
              }}
              loading={
                <div className="loading-block" style={{ padding: '20px 16px' }}>
                  <span className="spinner" />
                  <span>正在渲染差异视图…</span>
                </div>
              }
            />
          )}
        </div>

        {onAskLine && picked && (
          <div className="diff-ask">
            <span className="diff-ask-meta">
              {picked.side === 'modified' ? '应用之后' : '磁盘上现在'} · 第 {picked.line} 行
            </span>
            <code className="diff-ask-line">{picked.text.trim() || '（空行）'}</code>
            <button type="button" onClick={() => ask('explain')}>
              解释这行
            </button>
            <button type="button" onClick={() => ask('edit')}>
              改这行
            </button>
            <button type="button" onClick={() => ask('usages')}>
              谁在用
            </button>
          </div>
        )}

        <div className="modal-foot">
          <span className="modal-note">
            {patch.summary ? `${patch.summary} · ` : ''}
            左边是磁盘现状，右边是应用后的结果。点某一行可以接着问。不点应用，磁盘不会变。
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
