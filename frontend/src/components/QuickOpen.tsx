import { useEffect, useMemo, useRef, useState } from 'react';

import type { FileNode } from '../lib/api';
import { CloseIcon, SearchIcon } from './icons';

/**
 * Ctrl+P 快速打开：按文件名 / 路径过滤，键盘选中回车打开。
 * 不用 .modal —— 那套取景框和显影动画是给大弹窗的，这里只要一张轻卡片。
 */
interface QuickOpenProps {
  files: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}

function rankFiles(files: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, 40);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const name = (path.split('/').pop() ?? path).toLowerCase();
    const full = path.toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (name.includes(needle)) score = 50;
    else if (full.includes(needle)) score = 20;
    else continue;
    scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, 40).map((item) => item.path);
}

export function flattenFiles(nodes: FileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'dir') walk(node.children ?? []);
      else out.push(node.path);
    }
  };
  walk(nodes);
  return out;
}

export function QuickOpen({ files, onPick, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const hits = useMemo(() => rankFiles(files, query), [files, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (path: string) => {
    onPick(path);
    onClose();
  };

  return (
    <div className="modal-backdrop quick-open-backdrop" onClick={onClose}>
      <div
        className="quick-open"
        role="dialog"
        aria-label="快速打开文件"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="quick-open-bar">
          <SearchIcon size={14} />
          <input
            ref={inputRef}
            className="quick-open-input"
            value={query}
            placeholder="输入文件名或路径…"
            aria-label="搜索文件"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((current) => Math.min(current + 1, Math.max(hits.length - 1, 0)));
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((current) => Math.max(current - 1, 0));
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const target = hits[index];
                if (target) pick(target);
              }
            }}
          />
          <button className="icon-btn" title="关闭（Esc）" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="quick-open-list" ref={listRef}>
          {hits.length === 0 ? (
            <div className="quick-open-empty">{files.length === 0 ? '工作区还没有文件' : '没有匹配的文件'}</div>
          ) : (
            hits.map((path, i) => {
              const name = path.split('/').pop() ?? path;
              return (
                <button
                  key={path}
                  type="button"
                  className={`quick-open-row${i === index ? ' on' : ''}`}
                  data-active={i === index ? 'true' : undefined}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(path)}
                >
                  <span className="quick-open-name">{name}</span>
                  <span className="quick-open-path">{path}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="quick-open-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}
