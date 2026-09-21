import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import type { ConstitutionView } from '../lib/api';
import { CloseIcon, SaveIcon } from './icons';

/**
 * 仓库宪法面板：查看 / 编辑 / 从模板开始。
 *
 * 宪法是用户为本仓库写下的最高优先级规则，会整段注入 Agent 的 system prompt，
 * 并且 **Agent 没有任何工具能修改它** —— 这个面板是唯一的写入口。
 * 提交空内容等同撤回宪法（下次对话不再注入）。
 */
interface ConstitutionModalProps {
  workspaceId: number;
  onClose: () => void;
  onSaved: (view: ConstitutionView) => void;
}

export function ConstitutionModal({ workspaceId, onClose, onSaved }: ConstitutionModalProps) {
  const [view, setView] = useState<ConstitutionView | null>(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.constitution(workspaceId);
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

  const loadTemplate = async () => {
    try {
      const template = await api.constitutionTemplate(workspaceId);
      setText(template.content);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveConstitution(workspaceId, text);
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
          <span className="modal-title">仓库宪法</span>
          <span className="chip mono">.wca/CONSTITUTION.md</span>
          {view && (
            <span className={`chip${view.exists ? '' : ' chip-warn'}`}>
              <span className={`dot ${view.exists ? 'dot-ok' : 'dot-warn'}`} />
              {view.exists ? '已生效，注入每次对话' : '未配置 —— Agent 不受宪法约束'}
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
            这里写下的每一条都会作为<b>最高优先级规则</b>注入对话：
            技术栈约束、代码风格、测试要求、禁止事项……
            与其他指引冲突时以宪法为准。Agent 只能遵守，<b>不能修改</b>。
          </p>
          {view && !view.exists && (
            <button className="btn btn-sm" onClick={() => void loadTemplate()}>
              从模板开始
            </button>
          )}
          <textarea
            className="constitution-editor mono"
            value={text}
            spellCheck={false}
            placeholder={'# 仓库宪法\n\n- 例：统一构造器注入，禁止字段 @Autowired\n- 例：任何行为变更必须附带测试\n- 例：禁止修改数据库迁移脚本'}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="constitution-foot">
            <span className="mono" style={{ color: 'var(--fg-3)' }}>
              {text.length} 字符（上限 64000，超长注入时会被截断）
            </span>
            {text.trim() === '' && (
              <span style={{ color: 'var(--amber)' }}>空内容保存 = 撤回宪法</span>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note">保存后立刻对下一轮对话生效</span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? <span className="spinner" /> : <SaveIcon size={12} />}
            保存宪法
          </button>
        </div>
      </div>
    </div>
  );
}
