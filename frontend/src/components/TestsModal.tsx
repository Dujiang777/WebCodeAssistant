import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import type { TestRunResult } from '../lib/api';
import { CloseIcon, PlayIcon, RefreshIcon } from './icons';

/**
 * 测试面板：一键在工作区里跑测试套件，失败用例逐条列出，
 * 每条带「让 AI 修」—— 把真实的失败信息（类 / 方法 / 行号 / 断言原文）
 * 组装成一条聊天消息喂给 Agent，走「测试失败驱动改代码」的闭环。
 *
 * 与编译闭环同一个原则：跑不了就如实说 unavailable，绝不把「没跑」包装成「通过」。
 */
interface TestsModalProps {
  workspaceId: number;
  onClose: () => void;
  onFixWithAi: (result: TestRunResult) => void;
}

export function TestsModal({ workspaceId, onClose, onFixWithAi }: TestsModalProps) {
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.runTests(workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusClass =
    result?.status === 'ok' ? 'tests-ok' : result?.status === 'failed' ? 'tests-fail' : 'tests-warn';
  const statusLabel =
    result?.status === 'ok'
      ? '测试通过'
      : result?.status === 'failed'
        ? '测试失败'
        : result?.status === 'timeout'
          ? '运行超时'
          : result?.status === 'disabled'
            ? '已关闭'
            : '未执行';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">测试运行</span>
          {result && (
            <span className={`tests-status ${statusClass}`}>
              {statusLabel}
              {result.exitCode != null ? ` · exit ${result.exitCode}` : ''}
              {` · ${(result.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          <div className="topbar-spacer" />
          <button className="icon-btn" title="重新运行" onClick={() => void run()}>
            <RefreshIcon size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="loading-block" style={{ padding: '32px 16px' }}>
              <span className="spinner" />
              <span>正在运行测试（首次运行可能要下载依赖，请稍等）…</span>
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
          {!loading && result && (
            <>
              <div className="tests-totals mono">
                {result.totals ? (
                  <>
                    <span>共 {result.totals.run} 个用例</span>
                    <span className={result.totals.failures > 0 ? 'del' : ''}>
                      失败 {result.totals.failures}
                    </span>
                    <span className={result.totals.errors > 0 ? 'del' : ''}>
                      错误 {result.totals.errors}
                    </span>
                    {result.totals.skipped != null && <span>跳过 {result.totals.skipped}</span>}
                  </>
                ) : (
                  <span>构建工具未报告用例统计</span>
                )}
                <span style={{ color: 'var(--fg-3)' }}>{result.buildSystem}</span>
              </div>

              {(result.issues ?? []).length > 0 && (
                <div className="banner error">
                  <span>
                    测试代码编译不过（{result.issues!.length} 条诊断），测试套件没有执行 ——
                    先修编译错误，测试结果才有意义：
                  </span>
                  <div className="tests-failures" style={{ marginTop: 8 }}>
                    {result.issues!.map((issue, index) => (
                      <div key={`${issue.file}:${issue.line ?? index}`} className="tests-failure">
                        <span className="mono tests-failure-name">
                          {issue.file}
                          {issue.line != null ? `:${issue.line}` : ''}
                        </span>
                        <span className="tests-failure-msg">{issue.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.failures.length > 0 && (
                <div className="tests-failures">
                  {result.failures.map((failure) => (
                    <div key={`${failure.testClass}.${failure.method ?? '?'}`} className="tests-failure">
                      <span className="mono tests-failure-name">
                        {failure.displayName}
                        {failure.line != null ? `:${failure.line}` : ''}
                      </span>
                      <span className="tests-failure-msg">{failure.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.failures.length === 0 && result.status === 'ok' && (
                <div className="banner success">没有失败用例。</div>
              )}

              <details className="tests-output">
                <summary className="mono">原始输出（尾部）</summary>
                <pre className="compile-output mono">{result.output || '（无输出）'}</pre>
              </details>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-note">
            {result?.status === 'failed'
              ? '把失败信息发给 AI，让它读代码后给出最小修复补丁'
              : '命令由服务端拼装并在工作区内执行，Agent 无法注入参数'}
          </span>
          <div className="topbar-spacer" />
          {result?.status === 'failed' && (
            <button className="btn btn-primary" onClick={() => onFixWithAi(result)}>
              <PlayIcon size={12} />
              让 AI 修复这些失败
            </button>
          )}
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
