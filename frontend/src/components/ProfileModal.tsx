import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import type { ConstitutionView } from '../lib/api';
import { CloseIcon, SaveIcon } from './icons';

/**
 * 项目说明：这个仓库希望模型怎么干活。宪法仍是硬规则，说明管口径和习惯。
 * 空内容保存等于撤回。模型没有工具能改这份文件。
 */
interface ProfileModalProps {
  workspaceId: number;
  onClose: () => void;
  onSaved: (view: ConstitutionView) => void;
}

export function ProfileModal({ workspaceId, onClose, onSaved }: ProfileModalProps) {
  const [view, setView] = useState<ConstitutionView | null>(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.profile(workspaceId);
        if (cancelled) return;
        setView(data);
        setText(data.content ?? '');
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveProfile(workspaceId, text);
      setView(saved);
      onSaved(saved);
      onClose();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">项目说明</span>
          <span className="chip mono">.wca/PROFILE.md</span>
          {view && (
            <span className={`chip${view.exists ? '' : ' chip-warn'}`}>
              <span className={`dot ${view.exists ? 'dot-ok' : 'dot-warn'}`} />
              {view.exists ? '已生效，每次对话都会带上' : '还没写 —— 模型只按宪法和仓库规则干活'}
            </span>
          )}
          <div className="topbar-spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          {loadError && <div className="banner error">{loadError}</div>}
          <p className="constitution-lead">
            写这个仓库的工作方式：技术口径、目录习惯、回答要多细。
            和<b>仓库宪法</b>冲突时以宪法为准。模型只能照做，<b>改不了这份说明</b>。
          </p>
          <textarea
            className="constitution-editor mono"
            value={text}
            spellCheck={false}
            placeholder={'# 项目说明\n\n- 这是一个 Spring Boot 服务，改动优先落在 src/main/java\n- 回答用中文，先给结论再给依据\n- 不要主动重构没被点名的文件'}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="constitution-foot">
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              {text.length} 字符（上限 16000）
            </span>
            {text.trim() === '' && <span style={{ color: 'var(--amber)' }}>空内容保存 = 撤回说明</span>}
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note">保存后立刻对下一轮对话生效</span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={saving || view === null} onClick={() => void save()}>
            {saving ? <span className="spinner" /> : <SaveIcon size={12} />}
            保存说明
          </button>
        </div>
      </div>
    </div>
  );
}
