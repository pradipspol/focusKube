import type { MouseEventHandler, ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  className?: string;
}

export function CloseButton({ label, onClick, children = <X size={16} />, className }: Props) {
  return (
    <button
      type="button"
      className={['close-button', className].filter(Boolean).join(' ')}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}