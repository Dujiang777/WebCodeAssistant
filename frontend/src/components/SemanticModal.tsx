import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import type { SemanticResult, SemanticStatus } from '../lib/api';
import { CloseIcon, RefreshIcon, SearchIcon } from './icons';

/**
 * 语义检索面板（功能 11）。
 *
 * 用自然语言找代码：「限流在哪做的」「哪里处理过期 token」—— 这类问题
 * grep 想不出关键词。向量检索在服务端做（embedding 模型可配），
 * 未配置时明确展示不可用原因，不装死。
 *
 * 点结果跳到编辑器对应行 —— 与引用证据的交互一致。
 */
interface SemanticModalProps {
  workspaceId: number;
  onClose: () => void;
  onOpenHit: (file: string, line: number) => void;
}

export function SemanticModal({ workspaceId, onClose, onOpenHit }: SemanticModalProps) {
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SemanticResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const loadStatus = async () => {
    try {
      setStatus(await api.semanticStatus(workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reindex = async () => {
    setIndexing(true);
    setError(null);
    try {
      await api.reindexSemantic(workspaceId);
      await loadStatus();
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.semanticSearch(workspaceId, q));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">语义检索</span>
          <span className="chip mono">embeddings · cosine</span>
          {status && (
            <span className={`chip${status.chunks === 0 ? ' chip-warn' : ''}`}>
              <span className={`dot ${status.chunks > 0 ? 'dot-ok' : 'dot-warn'}`} />
              {status.chunks > 0 ? `已索引 ${status.chunks} 块` : '未建索引'}
            </span>
          )}
          <div className="topbar-spacer" />
          <button className="icon-btn" onClick={() => void reindex()} disabled={indexing} title="全量重建语义索引">
            <RefreshIcon size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="banner error">{error}</div>}

          <div className="semantic-searchbar">
            <SearchIcon size={14} />
            <input
              className="snapshots-input mono"
              value={query}
              placeholder="自然语言描述，例如「数据库连接池在哪配置」「哪里处理过期 token」"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void search();
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={busy || !query.trim()} onClick={() => void search()}>
              {busy ? <span className="spinner" /> : <SearchIcon size={12} />}
              检索
            </button>
          </div>

          {status && !status.available && (
            <div className="banner info">
              语义检索未启用：服务端未配置 embedding 模型（环境变量 LLM_EMBED_MODEL，OpenAI 兼容 /v1/embeddings）。
              正则 grep 与对话不受影响。配置后点上方 ↻ 按钮建索引即可。
            </div>
          )}

          {result && result.status !== 'ok' && (
            <div className="banner info">
              {result.note}
            </div>
          )}

          {result && result.status === 'ok' && result.hits.length === 0 && (
            <div className="snapshots-empty">没有找到相关代码块。换个描述再试，或改用 grep 精确关键字。</div>
          )}

          <div className="semantic-hits">
            {(result?.hits ?? []).map((hit) => (
              <button
                key={`${hit.path}:${hit.startLine}`}
                className="semantic-hit"
                onClick={() => {
                  onOpenHit(hit.path, hit.startLine);
                  onClose();
                }}
                title="点击跳到编辑器对应行"
              >
                <div className="semantic-hit-head mono">
                  <span>{hit.path}:{hit.startLine}-{hit.endLine}</span>
                  <span className="semantic-score">score {hit.score.toFixed(3)}</span>
                </div>
                <pre className="semantic-code mono">{hit.content}</pre>
              </button>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note">索引是显式的：改动代码后点 ↻ 重建。向量存服务端 jsonb，检索在 Java 侧做。</span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
