import type { MouseEvent } from 'react';

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
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="3" r="1" />
        <circle cx="8" cy="8" r="1" />
        <circle cx="8" cy="13" r="1" />
      </svg>
    </button>
  );
}
