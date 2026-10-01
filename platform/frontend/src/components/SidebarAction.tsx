import type { MouseEvent } from 'react';
import { EllipsisVertical } from 'lucide-react';

interface Props {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}

export function SidebarAction({ label, onClick, disabled = false }: Props) {
  return (
    <button
      className="sidebar-action-button"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        window.dispatchEvent(new CustomEvent('sidebar-context-menu-open'));
        onClick(event);
      }}
    >
      <EllipsisVertical size={16} aria-hidden="true" />
    </button>
  );
}
