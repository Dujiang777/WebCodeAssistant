import { useEffect, useRef, useState } from 'react';

import type { GitFileChange, GitStatus, PatchRecord } from '../lib/api';
import { suggestCommit } from '../lib/git';

interface GitBarProps {
  git: GitStatus | null;
  busy: boolean;
  patches: PatchRecord[];
  onInit: () => void;
  onCommit: (message: string) => void;
  onOpenFile: (path: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  modified: '改',
  added: '新',
  deleted: '删',
  untracked: '未',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function GitBar({ git, busy, patches, onInit, onCommit, onOpenFile }: GitBarProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessage((current) => current.trim() || suggestCommit(patches));
  }, [open, patches]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
  const recent = git.recent ?? [];

  return (
    <span className="statusbar-item git-chip" ref={box}>
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
                <GitFileRow key={file.path} file={file} onOpen={onOpenFile} />
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
          {recent.length > 0 && (
            <ol className="git-log">
              {recent.map((entry) => (
                <li key={entry.sha}>
                  <code>{entry.sha}</code>
                  <span>{entry.message || '（没有说明）'}</span>
                  <time>{stamp(entry.at)}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </span>
  );
}

function GitFileRow({ file, onOpen }: { file: GitFileChange; onOpen: (path: string) => void }) {
  const gone = file.kind === 'deleted';
  return (
    <li>
      <button
        type="button"
        className="git-file"
        disabled={gone}
        title={gone ? '已经从磁盘删掉了' : `打开 ${file.path}`}
        onClick={() => onOpen(file.path)}
      >
        <i>{kindLabel(file.kind)}</i>
        {file.path}
      </button>
    </li>
  );
}
