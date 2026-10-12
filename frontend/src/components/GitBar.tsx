import { useEffect, useState } from 'react';

import type { GitStatus, PatchRecord } from '../lib/api';
import { suggestCommit } from '../lib/git';

interface GitBarProps {
  git: GitStatus | null;
  busy: boolean;
  patches: PatchRecord[];
  onInit: () => void;
  onCommit: (message: string) => void;
}

export function GitBar({ git, busy, patches, onInit, onCommit }: GitBarProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setMessage((current) => current.trim() || suggestCommit(patches));
  }, [open, patches]);

  if (!git) {
    return <span className="statusbar-item git-chip">Git …</span>;
  }

  if (!git.repo) {
    return (
      <span className="statusbar-item git-chip">
        <button
          type="button"
          className="git-chip-btn"
          disabled={busy}
          title="这个工作区还不是仓库。初始化后才能按补丁提交。"
          onClick={onInit}
        >
          {busy ? '初始化…' : '未跟踪 · 初始化 Git'}
        </button>
      </span>
    );
  }

  const label = git.dirty > 0 ? `${git.branch} · ${git.dirty} 处未提交` : `${git.branch} · 干净`;

  return (
    <span className="statusbar-item git-chip">
      <button
        type="button"
        className={`git-chip-btn${git.dirty > 0 ? ' dirty' : ''}`}
        title={git.lastCommit ? `上一笔：${git.lastCommit}` : '本地仓库'}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div className="git-pop">
          <div className="git-pop-head">
            {git.dirty > 0 ? `${git.dirty} 个文件待提交` : '工作区干净'}
            <button type="button" className="git-pop-close" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          {git.files.length > 0 && (
            <ul className="git-files">
              {git.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
              {git.dirty > git.files.length && <li>…还有 {git.dirty - git.files.length} 个</li>}
            </ul>
          )}
          {git.dirty > 0 && (
            <>
              <textarea
                className="git-msg"
                rows={3}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="提交说明，默认从已应用补丁带过来"
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !message.trim()}
                onClick={() => {
                  onCommit(message.trim());
                  setOpen(false);
                }}
              >
                {busy ? '提交中…' : '提交这一笔'}
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
