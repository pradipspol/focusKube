export interface ToastMessage {
  id: number;
  tone: 'info' | 'success' | 'error';
  text: string;
}

interface Props {
  toasts: ToastMessage[];
}

export function ToastViewport({ toasts }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}