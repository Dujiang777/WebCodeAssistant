import { useState } from 'react';

import type { BuildResult } from '../lib/api';
import { PlayIcon, RefreshIcon, WrenchIcon } from './icons';

/**
 * 编译结果条 —— 「Patch → compile → 自动修」闭环的可见部分。
 *
 * 一条硬性原则：**「没编译」绝不显示成「编译通过」**。后端用
 * ok / failed / timeout / unavailable / disabled 五种状态区分，
 * 这里也如实分开展示；一个谎报成功的检查比没有检查更糟。
 */
interface CompileStripProps {
  busy: boolean;
  result: BuildResult | null;
  onCompile: () => void;
  onFix: (result: BuildResult) => void;
  onOpenIssue: (file: string, line: number | null) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function CompileStrip({ busy, result, onCompile, onFix, onOpenIssue }: CompileStripProps) {
  const [showOutput, setShowOutput] = useState(false);

  if (busy) {
    return (
      <div className="compile-strip compile-running">
        <span className="spinner" />
        <span>正在沙箱里编译…（首次构建需要下载依赖，可能要一两分钟）</span>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="compile-strip">
        <PlayIcon size={12} />
        <span className="compile-text">改动已写盘。要不要跑一次编译，确认它真的能编过？</span>
        <div className="topbar-spacer" />
        <button className="btn btn-sm" onClick={onCompile}>
          编译验证
        </button>
      </div>
    );
  }

  const tone =
    result.status === 'ok'
      ? 'compile-ok'
      : result.status === 'failed'
        ? 'compile-fail'
        : 'compile-warn';

  return (
    <div className={`compile-strip ${tone}`}>
      <div className="compile-head">
        <span
          className={`dot ${result.status === 'ok' ? 'dot-ok' : result.status === 'failed' ? 'dot-err' : 'dot-warn'}`}
        />
        <span className="compile-title">
          {result.status === 'ok' && `编译通过 · ${result.buildSystem} · ${formatDuration(result.durationMs)}`}
          {result.status === 'failed' &&
            `编译失败 · ${result.issues.length} 条诊断 · ${formatDuration(result.durationMs)}`}
          {result.status === 'timeout' && '编译超时'}
          {result.status === 'unavailable' && '未执行编译（工作区里没找到可用的构建工具）'}
          {/* disabled 有两种来路：编译未启用、或补丁还没应用。具体原因在 note 里，
              这里不替它下结论 —— 「没编译」绝不能显示成「编译通过」。 */}
          {result.status === 'disabled' && '未执行编译'}
        </span>

        <div className="topbar-spacer" />

        {result.status === 'failed' && result.issues.length > 0 && (
          <button className="btn btn-sm btn-primary" onClick={() => onFix(result)}>
            <WrenchIcon size={12} />
            让 AI 修复
          </button>
        )}
        <button className="btn btn-sm" onClick={onCompile} title="重新编译">
          <RefreshIcon size={12} />
        </button>
      </div>

      {result.note && <div className="compile-note">{result.note}</div>}

      {result.issues.length > 0 && (
        <div className="compile-issues">
          {result.issues.map((issue, index) => (
            <button
              key={`${issue.file}-${issue.line}-${index}`}
              className="compile-issue"
              onClick={() => onOpenIssue(issue.file, issue.line)}
              title="点击跳到出错的那一行"
            >
              <span className="compile-issue-file">{issue.file}</span>
              {issue.line != null && <span className="compile-issue-line">:{issue.line}</span>}
              <span className="compile-issue-msg">{issue.message}</span>
            </button>
          ))}
        </div>
      )}

      {result.command && (
        <div className="compile-command">
          <code>{result.command}</code>
          <button className="link-btn" onClick={() => setShowOutput((value) => !value)}>
            {showOutput ? '收起原始输出' : '查看原始输出'}
          </button>
        </div>
      )}

      {showOutput && <pre className="compile-output">{result.output || '（没有输出）'}</pre>}
    </div>
  );
}
