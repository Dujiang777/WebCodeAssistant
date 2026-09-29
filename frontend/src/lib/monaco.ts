/**
 * Monaco 初始化：注册一个与整套 UI 同源的深色主题。
 *
 * 为什么不直接用内置的 vs-dark：它偏纯灰，和 Web Code Assistant 的暖调近黑底、
 * 黄铜金强调色对不上，编辑器和外壳会像两个产品拼起来的。
 * 这里的配色全部取自 global.css 的变量值（"Darkroom Brass" 设计系统）。
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
/** 暖纸浅色主题（lib/theme.ts 的 ivory）对应的编辑器主题。 */
export const WCA_LIGHT = 'wca-light';

let configured = false;

export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  monaco.editor.defineTheme(WCA_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b6353', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'f2cd8f' },
      { token: 'keyword.control', foreground: 'f2cd8f' },
      { token: 'string', foreground: 'd8c9a3' },
      { token: 'number', foreground: '7fc8a9' },
      { token: 'type', foreground: 'e8c88a' },
      { token: 'type.identifier', foreground: 'e8c88a' },
      { token: 'identifier', foreground: 'efefec' },
      { token: 'annotation', foreground: 'c9b8ff' },
      { token: 'delimiter', foreground: '9a9a95' },
      { token: 'operator', foreground: 'c2c2bd' },
      { token: 'tag', foreground: 'ff9d7a' },
      { token: 'attribute.name', foreground: 'd8c9a3' },
      { token: 'attribute.value', foreground: 'a8d9a0' },
    ],
    colors: {
      'editor.background': '#12100c',
      'editor.foreground': '#efefec',
      'editorLineNumber.foreground': '#4a4436',
      'editorLineNumber.activeForeground': '#e8b45a',
      'editor.lineHighlightBackground': '#191612',
      'editor.selectionBackground': '#3a2f1a',
      'editor.inactiveSelectionBackground': '#241e12',
      'editorCursor.foreground': '#e8b45a',
      'editorIndentGuide.background1': '#221e17',
      'editorIndentGuide.activeBackground1': '#332c1f',
      'editorWidget.background': '#12100c',
      'editorWidget.border': '#2e2a22',
      'editorSuggestWidget.background': '#12100c',
      'editorSuggestWidget.selectedBackground': '#2a2317',
      'editorGutter.background': '#12100c',
      'editorOverviewRuler.border': '#0b0a08',
      'scrollbarSlider.background': '#2e2a2280',
      'scrollbarSlider.hoverBackground': '#3e382bb0',
      'scrollbarSlider.activeBackground': '#4a4230c0',
      // 插入用很淡的石灰绿：插入远比删除常见，满屏金会和光标、行号抢；
      // 删除保持玫红。金只留给光标、活动行号这些「活着」的信号。
      'diffEditor.insertedTextBackground': '#57e3891c',
      'diffEditor.removedTextBackground': '#ff516318',
      'diffEditor.insertedLineBackground': '#57e38916',
      'diffEditor.removedLineBackground': '#ff516314',
    },
  });

  monaco.editor.defineTheme(WCA_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a7f66', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8a5a00' },
      { token: 'keyword.control', foreground: '8a5a00' },
      { token: 'string', foreground: '3d7a4f' },
      { token: 'number', foreground: '1f6fa8' },
      { token: 'type', foreground: '8a5a00' },
      { token: 'type.identifier', foreground: '8a5a00' },
      { token: 'identifier', foreground: '2a251b' },
      { token: 'annotation', foreground: '6b46c1' },
      { token: 'delimiter', foreground: '7a715c' },
      { token: 'operator', foreground: '5a5240' },
      { token: 'tag', foreground: 'b04a2a' },
      { token: 'attribute.name', foreground: '7a5c14' },
      { token: 'attribute.value', foreground: '3d7a4f' },
    ],
    colors: {
      'editor.background': '#faf7f0',
      'editor.foreground': '#2a251b',
      'editorLineNumber.foreground': '#b3a88c',
      'editorLineNumber.activeForeground': '#9c6d14',
      'editor.lineHighlightBackground': '#f0ebdd',
      'editor.selectionBackground': '#e3d2ab',
      'editor.inactiveSelectionBackground': '#efe5cd',
      'editorCursor.foreground': '#9c6d14',
      'editorIndentGuide.background1': '#e5decb',
      'editorIndentGuide.activeBackground1': '#cfc4a6',
      'editorWidget.background': '#faf7f0',
      'editorWidget.border': '#ddd5c2',
      'editorSuggestWidget.background': '#faf7f0',
      'editorSuggestWidget.selectedBackground': '#f0e6cf',
      'editorGutter.background': '#faf7f0',
      'editorOverviewRuler.border': '#f4f0e6',
      'scrollbarSlider.background': '#d8d0bc80',
      'scrollbarSlider.hoverBackground': '#c8bfa6b0',
      'scrollbarSlider.activeBackground': '#b8ad92c0',
      'diffEditor.insertedTextBackground': '#3ddc9722',
      'diffEditor.removedTextBackground': '#d23b4b22',
      'diffEditor.insertedLineBackground': '#3ddc9718',
      'diffEditor.removedLineBackground': '#d23b4b18',
    },
  });
}

/**
 * UI 主题 → 编辑器主题的联动入口（lib/theme.ts 的 applyTheme 调用）。
 * 墨玉与暗房黄铜共用同一套深色编辑器主题：两者都是深底，只有外壳强调色不同。
 */
export function setMonacoTheme(uiTheme: 'brass' | 'emerald' | 'ivory'): void {
  configureMonaco();
  monaco.editor.setTheme(uiTheme === 'ivory' ? WCA_LIGHT : WCA_THEME);
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
