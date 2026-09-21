/**
 * Monaco 初始化：注册一个与整套 UI 同源的深色主题。
 *
 * 为什么不直接用内置的 vs-dark：它偏纯灰，和 Web Code Assistant 的碳墨底色、
 * 信号绿强调色对不上，编辑器和外壳会像两个产品拼起来的。
 * 这里的配色全部取自 global.css 的变量值。
 *
 * 另外刻意关掉了 minimap 与 semanticHighlighting —— 在网页 IDE 里前者太占宽度，
 * 后者需要 LSP（属于 V2），留着只会误导用户以为有语义分析。
 */

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// 让 @monaco-editor/react 使用本地打包的 monaco，而不是从 CDN 拉取：
// 内网 / 离线环境（以及 Docker 部署）下 CDN 通常不可达。
loader.config({ monaco });

export const WCA_THEME = 'wca-dark';

let configured = false;

export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  monaco.editor.defineTheme(WCA_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '4e6156', fontStyle: 'italic' },
      { token: 'keyword', foreground: '3af0a6' },
      { token: 'keyword.control', foreground: '3af0a6' },
      { token: 'string', foreground: 'e8c88a' },
      { token: 'number', foreground: '8ad7ff' },
      { token: 'type', foreground: '6fd3e8' },
      { token: 'type.identifier', foreground: '6fd3e8' },
      { token: 'identifier', foreground: 'deebe3' },
      { token: 'annotation', foreground: 'c9b8ff' },
      { token: 'delimiter', foreground: '8fa79a' },
      { token: 'operator', foreground: 'a9c2b4' },
      { token: 'tag', foreground: 'ff9d7a' },
      { token: 'attribute.name', foreground: 'e8c88a' },
      { token: 'attribute.value', foreground: 'a8d9a0' },
    ],
    colors: {
      'editor.background': '#0f1512',
      'editor.foreground': '#deebe3',
      'editorLineNumber.foreground': '#33443c',
      'editorLineNumber.activeForeground': '#3af0a6',
      'editor.lineHighlightBackground': '#141d18',
      'editor.selectionBackground': '#1e3a2f',
      'editor.inactiveSelectionBackground': '#16261f',
      'editorCursor.foreground': '#3af0a6',
      'editorIndentGuide.background1': '#1c2722',
      'editorIndentGuide.activeBackground1': '#2a3a33',
      'editorWidget.background': '#121a16',
      'editorWidget.border': '#223028',
      'editorSuggestWidget.background': '#121a16',
      'editorSuggestWidget.selectedBackground': '#1c2b24',
      'editorGutter.background': '#0f1512',
      'editorOverviewRuler.border': '#0a0f0d',
      'scrollbarSlider.background': '#24352d80',
      'scrollbarSlider.hoverBackground': '#33503fb0',
      'scrollbarSlider.activeBackground': '#3f6350c0',
      'diffEditor.insertedTextBackground': '#3af0a618',
      'diffEditor.removedTextBackground': '#ff6e7f18',
      'diffEditor.insertedLineBackground': '#3af0a614',
      'diffEditor.removedLineBackground': '#ff6e7f14',
    },
  });
}

/** 编辑器通用选项：偏向 IDE 观感，关掉与 V2 能力相关的提示。 */
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "ui-monospace, 'JetBrains Mono', Consolas, 'Courier New', monospace",
  fontLigatures: false,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderLineHighlight: 'line',
  renderWhitespace: 'selection',
  tabSize: 4,
  insertSpaces: true,
  automaticLayout: true,
  wordWrap: 'off',
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: false },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  padding: { top: 10, bottom: 18 },
  fixedOverflowWidgets: true,
  contextmenu: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  // 没有 LSP，这些提示只会给出错误信息，先关掉
  parameterHints: { enabled: true },
  unicodeHighlight: { ambiguousCharacters: false },
};

export const DIFF_OPTIONS: monaco.editor.IStandaloneDiffEditorConstructionOptions = {
  ...EDITOR_OPTIONS,
  readOnly: true,
  renderSideBySide: true,
  ignoreTrimWhitespace: false,
  renderOverviewRuler: false,
  diffWordWrap: 'off',
  originalEditable: false,
};
