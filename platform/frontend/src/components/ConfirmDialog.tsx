import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { uiText } from '../text';

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  details?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export type { ConfirmFn };

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    // A new request supersedes any dialog still open.
    resolveRef.current?.(false);
    setPending(options);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="overlay center" onClick={() => settle(false)}>
          <div
            className="modal-card confirm-modal"
            role="alertdialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">{pending.title ?? uiText.confirmDialog.defaultTitle}</h3>
              <button aria-label={uiText.confirmDialog.closeLabel} onClick={() => settle(false)}>
                {uiText.common.close}
              </button>
            </div>
            <div className="modal-body confirm-body">
              <div className="confirm-message">{pending.message}</div>
              {pending.details && <div className="confirm-details dim">{pending.details}</div>}
            </div>
            <div className="modal-footer">
              <button onClick={() => settle(false)}>{pending.cancelLabel ?? uiText.confirmDialog.no}</button>
              <button
                autoFocus
                className={pending.tone === 'default' ? 'primary' : 'confirm-danger'}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? uiText.confirmDialog.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
