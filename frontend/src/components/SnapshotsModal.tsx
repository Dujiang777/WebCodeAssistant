import { useEffect, useState } from 'react';

import { api, formatBytes } from '../lib/api';
import type { SnapshotView } from '../lib/api';
import { CloseIcon, PlusIcon, TrashIcon, RefreshIcon } from './icons';

/**
 * 快照面板：查看 / 手动打点 / 回滚 / 删除。
 *
 * 自动快照在每次应用补丁前由后端自动创建（打点失败则补丁不落盘）；
 * 这里是手动入口与回滚控制台。回滚是真·时点恢复 —— 快照之外新增的文件会被删掉，
 * 所以按钮上要写清楚后果，并要求二次确认。
 */
interface SnapshotsModalProps {
  workspaceId: number;
  onClose: () => void;
  onRestored: () => void;
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function SnapshotsModal({ workspaceId, onClose, onRestored }: SnapshotsModalProps) {
  const [snapshots, setSnapshots] = useState<SnapshotView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.snapshots(workspaceId);
      setSnapshots(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirmId) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmId]);

  const create = async () => {
    setBusy('create');
    try {
      await api.createSnapshot(workspaceId, label.trim());
      setLabel('');
      setNotice('快照已创建');
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (snapshot: SnapshotView) => {
    setBusy(snapshot.id);
    setConfirmId(null);
    try {
      await api.restoreSnapshot(workspaceId, snapshot.id);
      setNotice(`已回滚到 ${timeLabel(snapshot.createdAt)}（刷新文件树可看到恢复后的内容）`);
      onRestored();
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (snapshot: SnapshotView) => {
    setBusy(snapshot.id);
    try {
      await api.deleteSnapshot(workspaceId, snapshot.id);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">快照与回滚</span>
          <span className="chip mono">data/snapshots</span>
          {snapshots && (
            <span className="chip mono">
              {snapshots.length} 个快照
            </span>
          )}
          <div className="topbar-spacer" />
          <button className="icon-btn" onClick={() => void load()} title="刷新">
            <RefreshIcon size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal-body">
          {loadError && <div className="banner error">{loadError}</div>}
          {notice && <div className="banner ok">{notice}</div>}

          <p className="snapshots-lead">
            每次应用补丁前会<b>自动打点</b>（打点失败则补丁不落盘）；
            也可以在改动手动改代码前后手动创建。回滚 = 整个工作区回到该时点：
            快照之后新增的文件会被删除（node_modules 等构建产物不受影响）。
          </p>

          <div className="snapshots-create">
            <input
              className="snapshots-input mono"
              value={label}
              maxLength={120}
              placeholder="说明（可选）：例如「重构 UserService 之前」"
              onChange={(event) => setLabel(event.target.value)}
            />
            <button
              className="btn btn-primary btn-sm"
              disabled={busy === 'create'}
              onClick={() => void create()}
            >
              {busy === 'create' ? <span className="spinner" /> : <PlusIcon size={12} />}
              打快照
            </button>
          </div>

          {snapshots && snapshots.length === 0 && (
            <div className="snapshots-empty">
              还没有快照。应用第一个补丁时系统会自动创建，或现在手动打一个。
            </div>
          )}

          <div className="snapshots-list">
            {(snapshots ?? []).map((snapshot) => (
              <div key={snapshot.id} className="snapshot-row">
                <span className={`snapshot-kind mono ${snapshot.kind === 'auto' ? 'kind-auto' : 'kind-manual'}`}>
                  {snapshot.kind === 'auto' ? 'AUTO' : 'MANUAL'}
                </span>
                <div className="snapshot-main">
                  <div className="snapshot-label">{snapshot.label ?? '(无说明)'}</div>
                  <div className="snapshot-meta mono">
                    {timeLabel(snapshot.createdAt)} · {snapshot.fileCount} 文件 · {formatBytes(snapshot.sizeBytes)}
                  </div>
                </div>
                <div className="snapshot-actions">
                  {confirmId === snapshot.id ? (
                    <>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busy === snapshot.id}
                        onClick={() => void restore(snapshot)}
                      >
                        {busy === snapshot.id ? <span className="spinner" /> : null}
                        确认回滚
                      </button>
                      <button className="btn btn-sm" onClick={() => setConfirmId(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm"
                      disabled={busy === snapshot.id}
                      onClick={() => setConfirmId(snapshot.id)}
                      title="把整个工作区恢复到这个时点"
                    >
                      <RefreshIcon size={12} />
                      回滚到此
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    disabled={busy === snapshot.id}
                    onClick={() => void remove(snapshot)}
                    title="删除快照"
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note">自动快照每个工作区最多保留 15 个，超出自动淘汰最旧的</span>
          <div className="topbar-spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
