import { useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react';

import type { FileContent, NavigateView } from '../lib/api';
import { api } from '../lib/api';
import { EDITOR_OPTIONS, WCA_THEME } from '../lib/monaco';
import { clearIdeMarkers, setIdeMarkers, setupEditorIde } from '../lib/editorIde';
import type { Selection } from '../lib/chat';
import { TerminalMark, SaveIcon, CloseIcon, SearchIcon } from './icons';

/** 诊断计数（状态栏显示用）。null = 当前没有可诊断的文件。 */
export interface DiagnosticCounts {
  errors: number;
  warnings: number;
}

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
  workspaceId: number | null;
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
  /** Ctrl+Click / F12 请求符号导航（文件 1-based 行列号）。 */
  onNavigateSymbol: (file: string, line: number, column: number) => void;
  /** 最近一次导航的结果；null 表示面板关闭。 */
  navigate: NavigateView | null;
  onCloseNavigate: () => void;
  /** 点导航面板里的位置时打开对应文件并滚到那一行。 */
  onOpenLocation: (file: string, line: number) => void;
  /** 诊断计数变化（状态栏显示）。null = 没有可诊断的文件。 */
  onDiagnosticsChange: (counts: DiagnosticCounts | null) => void;
}

export function EditorPane({
  workspaceId,
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
  onNavigateSymbol,
  navigate,
  onCloseNavigate,
  onOpenLocation,
  onDiagnosticsChange,
}: EditorPaneProps) {
  const readOnly = !file || file.binary || file.truncated;

  // Monaco 实例与命名空间：跳转与高亮都必须通过实例 API，不能用 props 声明式表达
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any>(null);
  // 导航回调需要「当前打开的文件」，而 onMount 闭包只会捕获挂载那一次的 props ——
  // 用 ref 中转，保证 Ctrl+Click 永远拿到最新文件
  const fileRef = useRef(file);
  fileRef.current = file;
  const navigateRef = useRef(onNavigateSymbol);
  navigateRef.current = onNavigateSymbol;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  // 诊断：文件内容变化后防抖 lint（编辑器缓冲区，不用等保存）。
  // 请求带序号，慢响应不许覆盖新响应 —— 打字快的时候旧 lint 还在路上是常态。
  const lintSeqRef = useRef(0);
  useEffect(() => {
    if (!file || file.binary || file.truncated || !workspaceId) {
      lintSeqRef.current += 1;
      onDiagnosticsChange(null);
      return;
    }
    const seq = ++lintSeqRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const issues = await api.lint(workspaceId, file.path, text);
        if (seq !== lintSeqRef.current) return; // 已经有更新的请求在路上
        const editor = editorRef.current;
        if (!editor) return;
        const counts = setIdeMarkers(editor, issues);
        onDiagnosticsChange(issues.length > 0 ? counts : { errors: 0, warnings: 0 });
      } catch {
        // lint 挂了不弹错 —— 诊断是增值能力，不能因为它打断编辑
      }
    }, 600);
    return () => window.clearTimeout(timer);
    // onDiagnosticsChange 来自父级渲染，不进依赖（进依赖会打断防抖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, text, workspaceId]);

  // 文件关闭/切到二进制时清掉残留的下划线标记
  useEffect(() => {
    if (!file || file.binary) {
      const editor = editorRef.current;
      if (editor) clearIdeMarkers(editor);
    }
  }, [file]);

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

              // UI 自检钩子：探针需要拿到编辑器实例断言运行时状态（选项/marker 数）
              (window as unknown as Record<string, unknown>).__wcaProbe = { editor, monaco: monacoApi };

              // 编辑器智能化：关内置 TS/JS 语义误报 + 注册跨文件补全。
              // 全局单例注册，路由往返重挂不会重复；workspaceId 走 ref 取最新值。
              setupEditorIde(monacoApi, () => workspaceIdRef.current);

              // 快速建议兜底：Monaco 内建的 quickSuggestions 自动触发在嵌入式场景
              // （@monaco-editor/react 多 model + fixedOverflowWidgets）下不稳定，
              // 实测真实键入也不弹；而 triggerSuggest 命令 100% 可靠。所以模仿
              // VSCode 的自动行为：单字符 word 输入后当前词 ≥2 字符时主动唤起。
              // 挂在内容变化而不是 keydown 上 —— 键盘、输入法、自动化注入全覆盖。
              let lastAutoTriggerAt = 0;
              editor.onDidChangeModelContent((event) => {
                if (event.changes.length !== 1) return;
                const change = event.changes[0];
                if (change.text.length !== 1 || !/^[a-zA-Z0-9_$]$/.test(change.text)) return;
                const now = Date.now();
                if (now - lastAutoTriggerAt < 800) return; // 面板已在打开链路中，让 Monaco 继续过滤
                const model = editor.getModel();
                const position = editor.getPosition();
                if (!model || !position) return;
                const word = model.getWordUntilPosition(position);
                if (!word.word || word.word.length < 2) return;
                lastAutoTriggerAt = now;
                editor.trigger('wca-auto', 'editor.action.triggerSuggest', null);
              });

              // 符号导航：Ctrl/Cmd+Click 或 Ctrl/Cmd+F12。
              // 刻意不接管鼠标事件链（preventDefault 也只在这一分支里做），
              // 普通点击、拖选完全不受影响。
              const requestNavigate = (lineNumber: number, column: number) => {
                const current = fileRef.current;
                if (!current || current.binary) return;
                navigateRef.current(current.path, lineNumber, column);
              };
              editor.onMouseDown((event) => {
                const trigger = event.event as unknown as { ctrlKey?: boolean; metaKey?: boolean };
                if (!(trigger.ctrlKey || trigger.metaKey) || !event.target.position) return;
                event.event.preventDefault();
                requestNavigate(event.target.position.lineNumber, event.target.position.column);
              });
              editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.F12, () => {
                const position = editor.getPosition();
                if (position) requestNavigate(position.lineNumber, position.column);
              });

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

        {/* 符号导航结果浮层：定义 + 引用，点击任何一条都直接跳 */}
        {navigate && file && !file.binary && (
          <div className="nav-panel">
            <div className="nav-head">
              <SearchIcon size={12} />
              <span className="nav-symbol">{navigate.symbol}</span>
              <span className="nav-count">
                {navigate.definition ? '已跳转到定义' : '未找到定义'} · 引用 {navigate.references.length}
              </span>
              <div className="topbar-spacer" />
              <button className="btn btn-sm" onClick={onCloseNavigate} title="关闭导航面板">
                <CloseIcon size={12} />
              </button>
            </div>

            <div className="nav-body">
              {navigate.definition ? (
                <button
                  className="nav-item nav-def"
                  onClick={() => onOpenLocation(navigate.definition!.file, navigate.definition!.line)}
                  title={`打开 ${navigate.definition.file}:${navigate.definition.line}`}
                >
                  <b>定义</b>
                  <span className="mono nav-path">{navigate.definition.file}:{navigate.definition.line}</span>
                  <span className="nav-text">{navigate.definition.text.trim()}</span>
                </button>
              ) : (
                <div className="nav-empty">
                  工作区里没找到「{navigate.symbol}」的声明 —— 它可能来自依赖 jar，或是点在了字符串里。
                </div>
              )}

              {navigate.references.length > 0 && (
                <>
                  <div className="nav-group">引用（{navigate.references.length}）</div>
                  {navigate.references.map((ref, index) => (
                    <button
                      key={`${ref.file}:${ref.line}:${index}`}
                      className="nav-item"
                      onClick={() => onOpenLocation(ref.file, ref.line)}
                      title={`打开 ${ref.file}:${ref.line}`}
                    >
                      <span className="mono nav-path">{ref.file}:{ref.line}</span>
                      <span className="nav-text">{ref.text.trim()}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
