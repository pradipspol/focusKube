import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ToastMessage {
  id: number;
  tone: 'info' | 'success' | 'error';
  text: string;
}

export type PushToast = (tone: ToastMessage['tone'], text: string, durationMs?: number) => void;

const DEFAULT_TOAST_MS = 8000;

const ToastContext = createContext<PushToast | null>(null);

export function useToast(): PushToast {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast must be used within <ToastProvider>');
  return push;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef<number[]>([]);

  useEffect(() => () => timersRef.current.forEach((timer) => window.clearTimeout(timer)), []);

  const pushToast = useCallback<PushToast>((tone, text, durationMs = DEFAULT_TOAST_MS) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, tone, text }]);
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, durationMs);
    timersRef.current.push(timer);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={pushToast}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

interface Props {
  toasts: ToastMessage[];
  onDismiss?: (id: number) => void;
}

export function ToastViewport({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : undefined}
          onClick={() => onDismiss?.(toast.id)}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}