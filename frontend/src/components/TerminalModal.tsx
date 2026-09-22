import { useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import type { TerminalResult } from '../lib/api';
import { CloseIcon, PlayIcon } from './icons';

/**
 * 网页终端（功能 12）。
 *
 * 安全模型写在服务端：cwd 锁定工作区、拒绝管道/重定向/命令链、超时杀进程、输出截断。
 * 这个面板只由登录用户手动触发 —— 模型的工具清单里没有 run_command，这条红线不动。
 * 命令历史只存前端内存（刷新即清），不落库。
 */
interface TerminalModalProps {
  workspaceId: number;
  onClose: () => void;
}

interface HistoryEntry {
  command: string;
  result: TerminalResult | null;
  error: string | null;
}

export function TerminalModal({ workspaceId, onClose }: TerminalModalProps) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [history.length, busy]);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || busy) return;
    setBusy(true);
    setCommand('');
    let entry: HistoryEntry;
    try {
      const result = await api.runTerminal(workspaceId, cmd);
      entry = { command: cmd, result, error: null };
    } catch (err) {
      entry = { command: cmd, result: null, error: err instanceof Error ? err.message : String(err) };
    }
    setHistory((list) => [...list, entry]);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">终端</span>
          <span className="chip mono">cwd = 工作区根</span>
          <span className="chip" title="没有管道、重定向与命令链；超时 120 秒自动杀进程">
            受限模式
          </span>
          <div className="topbar-spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          <p className="terminal-lead">
            给<b>你</b>用的命令入口（mvn test、git status、node …）。AI 没有这个能力 ——
            它只能提补丁，命令始终由你亲手执行。不支持 <code className="mono">|</code> <code className="mono">&gt;</code>{' '}
            <code className="mono">&amp;&amp;</code> 等管道与命令链。
          </p>

          <div className="snapshots-create">
            <input
              className="snapshots-input mono"
              value={command}
              placeholder="输入命令，例如：mvn -q test"
              spellCheck={false}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run();
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={busy || !command.trim()} onClick={() => void run()}>
              {busy ? <span className="spinner" /> : <PlayIcon size={12} />}
              执行
            </button>
          </div>

          <div className="terminal-output">
            {history.length === 0 && !busy && (
              <div className="snapshots-empty">还没有执行过命令。</div>
            )}
            {history.map((entry, index) => (
              <div key={index} className="terminal-entry">
                <div className="terminal-cmdline mono">
                  <span className="terminal-prompt">$</span> {entry.command}
                </div>
                {entry.error && <div className="banner error">{entry.error}</div>}
                {entry.result && (
                  <>
                    <pre className="terminal-text mono">{entry.result.output || '(无输出)'}</pre>
                    <div className="terminal-meta mono">
                      exit={entry.result.exitCode ?? 'killed'} · {(entry.result.durationMs / 1000).toFixed(1)}s
                      {entry.result.timedOut && ' · 超时被杀'}
                      {entry.result.truncated && ' · 输出已截断'}
                    </div>
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div className="terminal-cmdline mono">
                <span className="terminal-prompt">$</span> {command || '执行中'} <span className="spinner" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note">命令历史仅保留在当前窗口，关闭即清空</span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
