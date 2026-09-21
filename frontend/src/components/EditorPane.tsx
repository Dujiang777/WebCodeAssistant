import { useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react';

import type { FileContent } from '../lib/api';
import { EDITOR_OPTIONS, WCA_THEME } from '../lib/monaco';
import type { Selection } from '../lib/chat';
import { TerminalMark, SaveIcon } from './icons';

/**
 * 中间的编辑器面板。
 *
 * 两个安全阀值得说明：
 *  1. <b>截断文件只读</b>。后端为控制内存只返回文件前 512 KB，若允许保存就等于
 *     用半截内容覆盖原文件 —— 这是能真正毁掉代码的操作，所以这里直接锁死编辑与保存；
 *  2. <b>二进制文件不渲染</b>。Monaco 没有二进制视图，硬塞乱码只会误导用户。
 *
 * 选区变化会上报给父级，作为下一轮对话的上下文（startLine/endLine/选中文本）。
 * 选区与光标的清理放在父级的 openFile 里做，这里只负责上报。
 *
 * <code>reveal</code> 是「引用跳转」的落点：对话里点一个 `路径:行号`，父级把
 * 文件打开并给出目标行，这里负责滚动到那一行并短暂高亮。用 token 做版本号而不是
 * 用对象身份，是为了让「再点一次同一处引用」也能重新触发一次高亮。
 */
export interface RevealTarget {
  path: string;
  line: number;
  token: number;
}

/**
 * 跳转高亮的停留时长。
 *
 * 2.6 秒实测偏短：眼睛还没落到那一行它就已经淡掉了，看起来像「点了没反应」。
 * 4 秒足够看清落点，又不会留下一个需要手动清除的状态。
 */
const HIGHLIGHT_MS = 4000;

interface EditorPaneProps {
  file: FileContent | null;
  text: string;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  reveal: RevealTarget | null;
  onChange: (text: string) => void;
  onSave: () => void;
  onSelectionChange: (selection: Selection | null) => void;
  onCursorChange: (cursor: { line: number; column: number }) => void;
  onRequestCreate: () => void;
}

export function EditorPane({
  file,
  text,
  loading,
  dirty,
  saving,
  error,
  reveal,
  onChange,
  onSave,
  onSelectionChange,
  onCursorChange,
  onRequestCreate,
}: EditorPaneProps) {
  const readOnly = !file || file.binary || file.truncated;

  // Monaco 实例与命名空间：跳转与高亮都必须通过实例 API，不能用 props 声明式表达
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any>(null);

  useEffect(() => {
    const editor = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!editor || !monacoApi || !reveal) return;
    // 文件还没切过来（openFile 是异步的）时先不跳，等 file 变化后这个 effect 会再跑一次
    if (!file || file.path !== reveal.path) return;

    const model = editor.getModel();
    const total = model?.getLineCount() ?? 1;
    const line = Math.min(Math.max(reveal.line, 1), total);

    editor.revealLineInCenter(line, monacoApi.editor.ScrollType.Smooth);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();

    decorationsRef.current?.clear();
    decorationsRef.current = editor.createDecorationsCollection([
      {
        range: new monacoApi.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'cite-line',
          linesDecorationsClassName: 'cite-line-gutter',
        },
      },
    ]);
    const timer = window.setTimeout(() => decorationsRef.current?.clear(), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [reveal, file]);

  return (
    <div className="pane">
      <div className="pane-head">
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: file ? 'var(--fg-0)' : 'var(--fg-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={file?.path ?? ''}
        >
          {file?.path ?? '未打开文件'}
        </span>

        {dirty && <span className="dirty-mark" />}

        <div className="topbar-spacer" />

        {file && <span className="chip">{file.language}</span>}
        {file?.binary && (
          <span className="chip" style={{ color: 'var(--rose)' }}>
            二进制
          </span>
        )}

        <button
          className={`btn btn-sm${dirty ? ' btn-primary' : ''}`}
          disabled={!dirty || saving || readOnly}
          onClick={onSave}
          title="保存（Ctrl/Cmd + S）"
        >
          {saving ? <span className="spinner" /> : <SaveIcon size={13} />}
          保存
        </button>
      </div>

      {error && (
        <div className="banner error">
          <span className="dot dot-err" />
          {error}
        </div>
      )}

      {file?.truncated && (
        <div className="banner">
          <span className="dot dot-warn" />
          文件超过单次读取上限，仅显示前 512 KB。为避免写坏原文件，此状态下禁止编辑与保存。
        </div>
      )}

      <div className="editor-wrap">
        {file?.binary ? (
          <div className="editor-empty">
            <TerminalMark size={30} />
            <div className="editor-empty-title">这是二进制文件</div>
            <div className="editor-empty-hint">
              {file.path}（{file.sizeBytes} 字节）无法以文本方式展示。
              可以直接在文件树上删除它，或让 AI 通过工具读取。
            </div>
          </div>
        ) : !file ? (
          <div className="editor-empty">
            <TerminalMark size={30} />
            <div className="editor-empty-title">
              {loading ? '正在打开文件…' : '从左边的文件树选一个文件'}
            </div>
            <div className="editor-empty-hint">
              打开文件后，右侧的对话会自动带上「当前文件 + 选中片段」作为上下文。
              选中一段代码再提问，AI 会聚焦在这段上，而不是猜你想改哪里。
            </div>
            <div className="row" style={{ gap: 10, marginTop: 4 }}>
              <span className="key-hint">Ctrl/⌘ + S</span>
              <span style={{ fontSize: 11.5 }}>保存</span>
              <span className="key-hint">Ctrl/⌘ + Enter</span>
              <span style={{ fontSize: 11.5 }}>发送给 AI</span>
            </div>
            <button className="btn btn-sm" onClick={onRequestCreate}>
              新建一个文件
            </button>
          </div>
        ) : (
          <Editor
            path={file.path}
            language={file.language}
            theme={WCA_THEME}
            value={text}
            options={{ ...EDITOR_OPTIONS, readOnly }}
            onChange={(value) => onChange(value ?? '')}
            loading={
              <div className="loading-block" style={{ padding: '16px 14px' }}>
                <span className="spinner" />
                <span>正在加载编辑器内核…</span>
              </div>
            }
            onMount={(editor, monacoApi) => {
              editorRef.current = editor;
              monacoRef.current = monacoApi;
              editor.onDidChangeCursorPosition((event) => {
                onCursorChange({ line: event.position.lineNumber, column: event.position.column });
              });
              editor.onDidChangeCursorSelection(() => {
                const model = editor.getModel();
                const selection = editor.getSelection();
                if (!model || !selection || selection.isEmpty()) {
                  onSelectionChange(null);
                  return;
                }
                onSelectionChange({
                  startLine: selection.startLineNumber,
                  endLine: selection.endLineNumber,
                  text: model.getValueInRange(selection),
                });
              });
            }}
          />
        )}
      </div>
    </div>
  );
}
