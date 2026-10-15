import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmAsk {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * 站内确认框。系统 confirm 会把暗房整页切走，这里用同一套黄铜弹层。
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确定',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmAsk & { onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={onCancel} role="presentation">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-body">{body}</p>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel} autoFocus={danger}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            autoFocus={!danger}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useConfirm(): { ask: (options: ConfirmAsk) => Promise<boolean>; dialog: ReactNode } {
  const [job, setJob] = useState<(ConfirmAsk & { resolve: (ok: boolean) => void }) | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;

  const ask = useCallback((options: ConfirmAsk) => {
    return new Promise<boolean>((resolve) => {
      jobRef.current?.resolve(false);
      setJob({ ...options, resolve });
    });
  }, []);

  const finish = useCallback((ok: boolean) => {
    const current = jobRef.current;
    setJob(null);
    current?.resolve(ok);
  }, []);

  const dialog = job ? (
    <ConfirmDialog
      title={job.title}
      body={job.body}
      confirmLabel={job.confirmLabel}
      danger={job.danger}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  ) : null;

  return { ask, dialog };
}
