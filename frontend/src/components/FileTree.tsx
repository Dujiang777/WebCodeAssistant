import { useEffect, useRef, useState } from 'react';

import type { FileNode } from '../lib/api';
import { formatBytes } from '../lib/api';
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
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
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: FileNode) => void;
  onRequestCreate: (parent: string, type: 'file' | 'dir') => void;
  onConfirmCreate: (path: string) => void;
  onCancelCreate: () => void;
  onDelete: (node: FileNode) => void;
  creating: CreateTarget | null;
  createBusy: boolean;
}

export function FileTree({
  nodes,
  loading,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onRequestCreate,
  onConfirmCreate,
  onCancelCreate,
  onDelete,
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

  return (
    <div className="tree">
      {creating && (
        <CreateRow
          target={creating}
          busy={createBusy}
          onSubmit={onConfirmCreate}
          onCancel={onCancelCreate}
        />
      )}

      {nodes.length === 0 && !creating ? (
        <div className="empty" style={{ padding: '26px 16px' }}>
          <div className="empty-title">工作区是空的</div>
          <div className="empty-text">
            用上面的 <PlusIcon size={11} /> 新建文件，或回到工作区列表导入一个仓库。
          </div>
        </div>
      ) : (
        nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onRequestCreate={onRequestCreate}
            onDelete={onDelete}
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
}: TreeRowProps) {
  const isDir = node.type === 'dir';
  const open = isDir && expanded.has(node.path);
  const selected = !isDir && node.path === selectedPath;
  const badge = isDir ? null : languageBadge(node.path);

  const indent = 8 + depth * 13;

  return (
    <>
      <div
        className={`tree-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
        title={node.path}
      >
        <span className={`tree-twisty${open ? ' open' : ''}`}>
          {isDir ? <ChevronIcon size={11} /> : null}
        </span>

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
