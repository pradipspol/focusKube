import type { MouseEventHandler } from 'react';
import { MoreVertical } from 'lucide-react';

interface Props {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

export function ActionMenuTrigger({ label, onClick }: Props) {
  return (
    <button
      type="button"
      className="action-trigger"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <MoreVertical size={16} aria-hidden="true" />
    </button>
  );
}