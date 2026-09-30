import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { uiText } from '../text';
import { Modal } from './Modal';

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
        <Modal
          title={pending.title ?? uiText.confirmDialog.defaultTitle}
          onClose={() => settle(false)}
          cardClassName="confirm-modal"
          bodyClassName="confirm-body"
          closeLabel={uiText.confirmDialog.closeLabel}
          role="alertdialog"
          footer={(
            <>
              <button onClick={() => settle(false)}>{pending.cancelLabel ?? uiText.confirmDialog.no}</button>
              <button
                autoFocus
                className={pending.tone === 'default' ? 'primary' : 'confirm-danger'}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? uiText.confirmDialog.confirm}
              </button>
            </>
          )}
        >
          <div className="confirm-message">{pending.message}</div>
          {pending.details && <div className="confirm-details dim">{pending.details}</div>}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
