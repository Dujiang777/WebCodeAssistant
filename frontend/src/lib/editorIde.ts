/**
 * 编辑器智能化层：把 Monaco 从「语法着色」提升到轻 IDE 的三件事。
 *
 *  1. <b>关掉内置 TS worker 的语义诊断</b>。Monaco 自带的 TypeScript worker
 *     在没有 node_modules / tsconfig 上下文时满屏「找不到模块」的假红线 ——
 *     比没有诊断更伤信任。语法验证也一并关掉：工作区常见 JSX/装饰器，默认
 *     编译选项下同样误报。诊断改由后端确定性 lint 承担（JSON 真解析 + 括号
 *     平衡），宁可少报不可吓人。
 *  2. <b>跨文件补全</b>。后端把工作区的类名/方法名/函数名提取成符号表
 *     （TTL 15 秒缓存），这里注册成 Monaco 的 completion provider。
 *     当前文档内的单词补全 Monaco 原生就有（wordBasedSuggestions），
 *     这个 provider 补的是「别的文件里定义的符号」。
 *  3. <b>诊断结果 → marker 的映射</b>（setIdeMarkers）。
 *
 * 注册都是全局单例：路由往返重挂 EditorPane 也不能重复注册，所以用模块级
 * 标志位；workspaceId 通过回调在请求时取最新值，不闭包捕获。
 */

import * as monaco from 'monaco-editor';

import { api, type CompletionSymbol, type LintIssue } from './api';

/** Monaco 的语言 id → 后端补全服务的适用范围。CSS 类名也能从工作区补。 */
const COMPLETION_LANGUAGES = [
  'java',
  'javascript',
  'typescript',
  'python',
  'go',
  'kotlin',
  'rust',
  'php',
  'css',
];

let ideConfigured = false;
let completionRegistered = false;

/** 取当前工作区 id 的回调（由 IdePage 提供，避免闭包捕获旧值）。 */
type WorkspaceIdGetter = () => number | null;

/**
 * 一次性初始化：关内置语义误报 + 注册跨文件补全。
 * 幂等，重复调用没有副作用。
 */
export function setupEditorIde(monacoApi: typeof monaco, getWorkspaceId: WorkspaceIdGetter): void {
  if (!ideConfigured) {
    ideConfigured = true;
    const ts = (monacoApi as unknown as {
      languages?: {
        typescript?: {
          typescriptDefaults: { setDiagnosticsOptions: (o: object) => void };
          javascriptDefaults: { setDiagnosticsOptions: (o: object) => void };
        };
      };
    }).languages?.typescript;
    if (ts) {
      // 关内置 TS/JS 诊断：没有项目上下文时全是「找不到模块」级别的假红线。
      // 语法问题由后端 lint 的括号/JSON 规则兜底，语义问题等 LSP。
      const options = { noSemanticValidation: true, noSyntaxValidation: true };
      ts.typescriptDefaults.setDiagnosticsOptions(options);
      ts.javascriptDefaults.setDiagnosticsOptions(options);
    }
  }

  if (completionRegistered) return;
  completionRegistered = true;
  registerCompletionProvider(monacoApi, getWorkspaceId);
}

/** 补全结果缓存：同一前缀的连续按键不打第二遍后端。 */
const completionCache = new Map<string, CompletionSymbol[]>();
const COMPLETION_CACHE_LIMIT = 80;

function registerCompletionProvider(monacoApi: typeof monaco, getWorkspaceId: WorkspaceIdGetter): void {
  monacoApi.languages.registerCompletionItemProvider(COMPLETION_LANGUAGES, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const workspaceId = getWorkspaceId();
      if (workspaceId === null) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const prefix = word.word;
      // 一个字符的前缀会命中大量无关符号，等用户再敲一个字符再出手
      if (!prefix || prefix.length < 2) return { suggestions: [] };

      const cacheKey = `${workspaceId}:${prefix}`;
      let symbols = completionCache.get(cacheKey);
      if (!symbols) {
        try {
          symbols = await api.completions(workspaceId, prefix);
        } catch {
          // 补全失败就静默退回单词补全，不该弹错误打断打字
          return { suggestions: [] };
        }
        completionCache.set(cacheKey, symbols);
        if (completionCache.size > COMPLETION_CACHE_LIMIT) {
          const oldest = completionCache.keys().next().value;
          if (oldest !== undefined) completionCache.delete(oldest);
        }
      }

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: symbols.map((symbol, index) => ({
          label: symbol.name,
          kind: symbolKind(monacoApi, symbol.kind),
          detail: `${kindLabel(symbol.kind)} · ${symbol.file}:${symbol.line}`,
          documentation: `${symbol.kind === 'class' ? '类型' : '符号'}定义于 ${symbol.file} 第 ${symbol.line} 行`,
          insertText: symbol.name,
          range,
          // 排在最前：工作区符号优先于 Monaco 内置的单词建议
          sortText: `0${String(index).padStart(3, '0')}`,
        })),
      };
    },
  });
}

function symbolKind(
  monacoApi: typeof monaco,
  kind: CompletionSymbol['kind'],
): monaco.languages.CompletionItemKind {
  const K = monacoApi.languages.CompletionItemKind;
  switch (kind) {
    case 'class':
      return K.Class;
    case 'function':
      return K.Function;
    case 'method':
      return K.Method;
    case 'field':
      return K.Field;
    default:
      return K.Variable;
  }
}

function kindLabel(kind: CompletionSymbol['kind']): string {
  switch (kind) {
    case 'class':
      return '类';
    case 'function':
      return '函数';
    case 'method':
      return '方法';
    case 'field':
      return '字段';
    default:
      return '变量';
  }
}

/** Monaco marker 严重级别：8 = Error，4 = Warning。 */
const SEVERITY_ERROR = 8;
const SEVERITY_WARNING = 4;

/** 后端 lint 结果 → Monaco markers。返回计数给状态栏显示。 */
export function setIdeMarkers(
  editor: monaco.editor.IStandaloneCodeEditor,
  issues: LintIssue[],
): { errors: number; warnings: number } {
  const model = editor.getModel();
  if (!model) return { errors: 0, warnings: 0 };
  const markers = issues.map((issue) => ({
    startLineNumber: issue.line,
    startColumn: issue.column,
    endLineNumber: issue.endLine,
    endColumn: Math.max(issue.endColumn, issue.column + 1),
    message: issue.message,
    severity: issue.severity === 'error' ? SEVERITY_ERROR : SEVERITY_WARNING,
    source: 'wca-lint',
  }));
  const owner = 'wca-lint';
  monaco.editor.setModelMarkers(model, owner, markers);
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** 清掉某个模型上的诊断标记（文件关闭/切换时用）。 */
export function clearIdeMarkers(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel();
  if (model) monaco.editor.setModelMarkers(model, 'wca-lint', []);
}
