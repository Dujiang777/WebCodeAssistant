import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { FileNode } from '../lib/api';
import { formatBytes } from '../lib/api';
import {
  ChevronIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
  languageBadge,
} from './icons';

/**
 * 文件树。
 *
 * 几个刻意的选择：
 *   - <b>不需要懒加载</b>：整棵树在创建时就已经拿到（后端限制了条目数上限），
 *     本地展开/折叠是纯内存操作，点击没有等待感；
 *   - <b>展开状态由父级持有</b>：应用补丁后刷新整棵树时，展开状态不会丢；
 *   - 新建走「内联输入行」而不是弹窗 —— 在 IDE 里弹窗打断心流，内联输入只要敲回车。
 */

export interface CreateTarget {
  parent: string;
  type: 'file' | 'dir';
}

interface FileTreeProps {
  nodes: FileNode[];
  loading: boolean;
  query?: string;
  onQueryChange?: (value: string) => void;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: FileNode) => void;
  onRequestCreate: (parent: string, type: 'file' | 'dir') => void;
  onConfirmCreate: (path: string) => void;
  onCancelCreate: () => void;
  onDelete: (node: FileNode) => void;
  onCopyPath?: (path: string) => void;
  redzone?: string[];
  traced?: Set<string>;
  patched?: Set<string>;
  onToggleRedzone?: (path: string) => void;
  creating: CreateTarget | null;
  createBusy: boolean;
}

function filterNodes(nodes: FileNode[], query: string): FileNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const walk = (list: FileNode[]): FileNode[] => {
    const next: FileNode[] = [];
    for (const node of list) {
      const hit = node.name.toLowerCase().includes(needle);
      const children = node.children ? walk(node.children) : [];
      if (hit || children.length > 0) {
        next.push(children.length > 0 ? { ...node, children } : node);
      }
    }
    return next;
  };
  return walk(nodes);
}

export function pathInRedzone(path: string, rules: string[]): boolean {
  const n = path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return rules.some((rule) => {
    const r = rule.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    return n === r || n.startsWith(`${r}/`);
  });
}

function dirsOf(nodes: FileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'dir') {
        out.push(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

export function FileTree({
  nodes,
  loading,
  query = '',
  onQueryChange,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onRequestCreate,
  onConfirmCreate,
  onCancelCreate,
  onDelete,
  onCopyPath,
  redzone = [],
  traced,
  patched,
  onToggleRedzone,
  creating,
  createBusy,
}: FileTreeProps) {
  if (loading) {
    return (
      <div className="loading-block" style={{ padding: '14px 12px' }}>
        <span className="spinner" />
        <span>正在扫描工作区…</span>
      </div>
    );
  }

  const visible = filterNodes(nodes, query);
  const forceOpen = query.trim() ? new Set(dirsOf(visible)) : null;

  return (
    <div className="tree">
      {onQueryChange && (
        <div className="tree-filter-wrap">
          <input
            className="input tree-filter"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="筛选文件名…"
            aria-label="筛选文件"
          />
        </div>
      )}
      {creating && (
        <CreateRow
          target={creating}
          busy={createBusy}
          onSubmit={onConfirmCreate}
          onCancel={onCancelCreate}
        />
      )}

      {visible.length === 0 && !creating ? (
        <div className="empty" style={{ padding: '26px 16px' }}>
          <div className="empty-title">{query.trim() ? '没有匹配的文件' : '工作区是空的'}</div>
          <div className="empty-text">
            {query.trim()
              ? '换个关键字，或清空筛选再看整棵树。'
              : '用上面的 + 新建文件，或回到工作区列表导入一个仓库。'}
          </div>
        </div>
      ) : (
        visible.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            expanded={forceOpen ?? expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onRequestCreate={onRequestCreate}
            onDelete={onDelete}
            onCopyPath={onCopyPath}
            redzone={redzone}
            traced={traced}
            patched={patched}
            onToggleRedzone={onToggleRedzone}
          />
        ))
      )}
    </div>
  );
}

interface TreeRowProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: FileNode) => void;
  onRequestCreate: (parent: string, type: 'file' | 'dir') => void;
  onDelete: (node: FileNode) => void;
  onCopyPath?: (path: string) => void;
  redzone: string[];
  traced?: Set<string>;
  patched?: Set<string>;
  onToggleRedzone?: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onRequestCreate,
  onDelete,
  onCopyPath,
  redzone,
  traced,
  patched,
  onToggleRedzone,
}: TreeRowProps) {
  const isDir = node.type === 'dir';
  const open = isDir && expanded.has(node.path);
  const selected = !isDir && node.path === selectedPath;
  const locked = pathInRedzone(node.path, redzone);
  const seen = traced?.has(node.path) ?? false;
  const hasPatch = patched?.has(node.path) ?? false;
  const badge = isDir ? null : languageBadge(node.path);

  const indent = 8 + depth * 13;

  // 键盘导航（roving tabindex）：Tab 进入树后，方向键在行间巡游，Enter/Space 激活。
  // 行是自绘 div（不是原生 button），这些能力必须自己给 —— 否则键盘用户根本走不到文件树里。
  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isDir) onToggle(node.path);
      else onSelect(node);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // 排除内联创建行（那是表单，不是树节点）
      const rows = Array.from(document.querySelectorAll<HTMLDivElement>('.tree-row:not(.create-row)'));
      const index = rows.indexOf(event.currentTarget);
      const next = rows[event.key === 'ArrowDown' ? index + 1 : index - 1];
      next?.focus();
      return;
    }
    if (isDir && event.key === 'ArrowRight' && !open) {
      event.preventDefault();
      onToggle(node.path);
      return;
    }
    if (isDir && event.key === 'ArrowLeft' && open) {
      event.preventDefault();
      onToggle(node.path);
    }
  };

  return (
    <>
      <div
        className={`tree-row${selected ? ' selected' : ''}${locked ? ' tree-row-redzone' : ''}${seen ? ' tree-row-traced' : ''}${hasPatch ? ' tree-row-patched' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
        onKeyDown={handleRowKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={isDir ? open : undefined}
        aria-current={selected ? 'true' : undefined}
        title={node.path}
      >
        {isDir ? (
          <span className={`tree-twisty${open ? ' open' : ''}`}>
            <ChevronIcon size={11} />
          </span>
        ) : (
          /* 文件行没有箭头，空出的 14px 位正好印「片边帧号」——
             像胶片边缘的 FRAME 编号，CSS counter 全自动：展开/折叠重排即重编。 */
          <span className="tree-twisty tree-frame-no" aria-hidden="true" />
        )}

        <span className="tree-glyph" style={badge ? { color: badge.color } : undefined}>
          {isDir ? (
            open ? (
              <FolderOpenIcon size={13} />
            ) : (
              <FolderIcon size={13} />
            )
          ) : badge ? (
            <span className="mono" style={{ fontSize: 9.5, fontWeight: 700 }}>
              {badge.label}
            </span>
          ) : (
            <FileIcon size={13} />
          )}
        </span>

        <span className="tree-name">{node.name}</span>

        {isDir ? (
          <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
            {onToggleRedzone && (
              <button
                className={`icon-btn${locked ? ' on' : ''}`}
                title={locked ? '解开禁区（允许 Agent 出补丁）' : '划入禁区（Agent 不能给这里出补丁）'}
                onClick={() => onToggleRedzone(node.path)}
              >
                <ShieldIcon size={12} />
              </button>
            )}
            <button
              className="icon-btn"
              title={`在 ${node.path} 下新建文件`}
              onClick={() => onRequestCreate(node.path, 'file')}
            >
              <PlusIcon size={12} />
            </button>
            <button
              className="icon-btn"
              title={`在 ${node.path} 下新建目录`}
              onClick={() => onRequestCreate(node.path, 'dir')}
            >
              <FolderIcon size={12} />
            </button>
            <button className="icon-btn" title="删除目录" onClick={() => onDelete(node)}>
              <TrashIcon size={12} />
            </button>
          </span>
        ) : (
          <>
            <span className="tree-size">{formatBytes(node.size)}</span>
            <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
              {onToggleRedzone && (
                <button
                  className={`icon-btn${locked ? ' on' : ''}`}
                  title={locked ? '解开禁区（允许 Agent 出补丁）' : '划入禁区（Agent 不能给这里出补丁）'}
                  onClick={() => onToggleRedzone(node.path)}
                >
                  <ShieldIcon size={12} />
                </button>
              )}
              {onCopyPath && (
                <button className="icon-btn" title="复制路径" onClick={() => onCopyPath(node.path)}>
                  <CopyIcon size={12} />
                </button>
              )}
              <button className="icon-btn" title="删除文件" onClick={() => onDelete(node)}>
                <TrashIcon size={12} />
              </button>
            </span>
          </>
        )}
      </div>

      {isDir &&
        open &&
        (node.children ?? []).map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onRequestCreate={onRequestCreate}
            onDelete={onDelete}
            onCopyPath={onCopyPath}
            redzone={redzone}
            traced={traced}
            patched={patched}
            onToggleRedzone={onToggleRedzone}
          />
        ))}
    </>
  );
}

/** 内联新建输入行：回车提交、Esc 取消、失焦即取消。 */
function CreateRow({
  target,
  busy,
  onSubmit,
  onCancel,
}: {
  target: CreateTarget;
  busy: boolean;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const full = target.parent ? `${target.parent}/${trimmed}` : trimmed;
    onSubmit(full.replace(/\/+/g, '/'));
  };

  return (
    <div className="tree-row create-row" style={{ paddingLeft: 8 }} onClick={(e) => e.stopPropagation()}>
      <span className={`tree-twisty${target.type === 'dir' ? ' open' : ''}`}>
        {target.type === 'dir' ? <ChevronIcon size={11} /> : null}
      </span>
      <span className="tree-glyph" style={{ color: target.type === 'dir' ? 'var(--ember)' : 'var(--cyan)' }}>
        {target.type === 'dir' ? <FolderOpenIcon size={13} /> : <FileIcon size={13} />}
      </span>
      <input
        ref={inputRef}
        className="tree-create-input mono"
        placeholder={target.type === 'dir' ? '新目录名' : '新文件名，如 Foo.java'}
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy) onCancel();
        }}
      />
      <span className="tree-size" style={{ fontFamily: 'var(--font-ui)' }}>
        {target.parent ? `${target.parent}/` : '根目录'}
      </span>
    </div>
  );
}
