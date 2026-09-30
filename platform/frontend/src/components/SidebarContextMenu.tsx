import { AnchoredMenu } from './AnchoredMenu';
import type { ReactNode } from 'react';

export interface SidebarContextMenuAction {
  label: string;
  onSelect: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  actions: SidebarContextMenuAction[];
  footer?: ReactNode;
}

export function SidebarContextMenu({ actions, footer }: Props) {
  return (
    <AnchoredMenu anchorSelector=".sidebar-action-button" className="sidebar-action-menu">
      {actions.map((action) => (
        <button
          key={action.label}
          className={`action-menu-item${action.danger ? ' danger' : ''}`}
          type="button"
          disabled={action.disabled}
          onClick={() => void action.onSelect()}
        >
          {action.label}
        </button>
      ))}
      {footer}
    </AnchoredMenu>
  );
}
