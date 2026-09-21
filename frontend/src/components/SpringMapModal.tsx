import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { SpringMapData, SpringMapNode } from '../lib/api';
import { CloseIcon, RefreshIcon } from './icons';

/**
 * Spring 地图面板：把工作区里的 Spring 组件按层排开，
 * 每个 Bean 带文件:行号（可点击跳转）、HTTP 端点与依赖注入关系。
 *
 * 每次打开都全量重扫（后端毫秒级），所以补丁应用后直接刷新就是最新结构。
 * 非 Spring 项目会明确显示「未发现组件」—— 不硬凑一张假地图。
 */
interface SpringMapModalProps {
  workspaceId: number;
  onClose: () => void;
  onOpenRef: (file: string, line: number | null) => void;
}

const LAYER_ORDER = ['0-config', '1-web', '2-service', '3-repository', '4-model', '5-other'];

const LAYER_LABEL: Record<string, string> = {
  '0-config': '配置',
  '1-web': 'Web 层（Controller）',
  '2-service': '服务层（Service）',
  '3-repository': '数据访问层（Repository）',
  '4-model': '模型（Entity）',
  '5-other': '其他组件',
};

const STEREOTYPE_COLOR: Record<string, string> = {
  Controller: 'var(--mint)',
  ControllerAdvice: 'var(--mint)',
  Service: 'var(--violet)',
  Repository: 'var(--amber)',
  Configuration: 'var(--fg-2)',
  Component: 'var(--fg-2)',
  Entity: 'var(--fg-3)',
};

export function SpringMapModal({ workspaceId, onClose, onOpenRef }: SpringMapModalProps) {
  const [data, setData] = useState<SpringMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.springMap(workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byLayer = useMemo(() => {
    const groups = new Map<string, SpringMapNode[]>();
    for (const node of data?.nodes ?? []) {
      const list = groups.get(node.layer) ?? [];
      list.push(node);
      groups.set(node.layer, list);
    }
    return groups;
  }, [data]);

  const layers = LAYER_ORDER.filter((layer) => byLayer.has(layer));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Spring 地图</span>
          {data && (
            <span className="chip mono">
              {data.nodes.length} Bean · {data.edges.length} 依赖 · 扫描 {data.scannedFiles} 文件
              {data.truncated ? '（已截断）' : ''}
            </span>
          )}
          <div className="topbar-spacer" />
          <button className="icon-btn" title="重新扫描" onClick={() => void load()}>
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
              <span>正在扫描 Spring 组件…</span>
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
          {!loading && !error && data && (
            <>
              <p className="springmap-note">{data.note}</p>
              {data.nodes.length === 0 ? (
                <div className="springmap-empty">
                  非 Spring 项目没有组件地图。对话里问结构类问题时，
                  Agent 会直接用 grep / list_dir 回答而不是硬凑地图。
                </div>
              ) : (
                <div className="springmap-layers">
                  {layers.map((layer) => (
                    <section key={layer} className="springmap-layer">
                      <div className="springmap-layer-head">
                        {LAYER_LABEL[layer] ?? layer}
                        <span className="mono" style={{ color: 'var(--fg-3)' }}>
                          {' '}
                          {byLayer.get(layer)!.length}
                        </span>
                      </div>
                      <div className="springmap-nodes">
                        {byLayer.get(layer)!.map((node) => {
                          const deps = data.edges.filter((edge) => edge.from === node.name);
                          const color = STEREOTYPE_COLOR[node.stereotype] ?? 'var(--fg-2)';
                          return (
                            <div key={node.name} className="springmap-node" style={{ borderColor: color }}>
                              <div className="springmap-node-head">
                                <button
                                  className="springmap-node-name mono"
                                  title={`打开 ${node.file}:${node.line}`}
                                  onClick={() => onOpenRef(node.file, node.line)}
                                >
                                  {node.name}
                                </button>
                                <span className="springmap-node-stereo" style={{ color }}>
                                  {node.stereotype}
                                </span>
                              </div>
                              {node.endpoints.length > 0 && (
                                <div className="springmap-endpoints mono">
                                  {node.endpoints.map((endpoint) => (
                                    <span key={endpoint} className="springmap-endpoint">
                                      {endpoint}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {deps.length > 0 && (
                                <div className="springmap-deps mono">
                                  → {deps.map((edge) => edge.to).join('、')}
                                </div>
                              )}
                              <button
                                className="springmap-file mono"
                                title={`打开 ${node.file}:${node.line}`}
                                onClick={() => onOpenRef(node.file, node.line)}
                              >
                                {node.file}:{node.line}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-note">点击类名或文件路径可在编辑器中跳转 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
