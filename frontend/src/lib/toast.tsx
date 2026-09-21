import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CloseIcon } from '../components/icons';

/**
 * 轻量 Toast。用 Context 而不是引第三方库：
 * 需求只有「显示一条几秒后消失的消息」，一个 provider + 3 个方法就够了。
 */

type ToastKind = 'error' | 'success' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  error: (text: string) => void;
  success: (text: string) => void;
  info: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, kind, text }].slice(-4));
      // 错误留久一点，方便阅读
      window.setTimeout(() => remove(id), kind === 'error' ? 7000 : 4000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      error: (text) => push('error', text),
      success: (text) => push('success', text),
      info: (text) => push('info', text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span className="dot" style={{ marginTop: 5 }}>
              <span
                className={`dot ${toast.kind === 'error' ? 'dot-err' : toast.kind === 'success' ? 'dot-ok' : 'dot-warn'}`}
              />
            </span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{toast.text}</span>
            <button className="toast-close" onClick={() => remove(toast.id)} aria-label="关闭">
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
