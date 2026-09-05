import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const menu = menuRef.current;
      const activeElement = document.activeElement as HTMLElement | null;
      const anchor = activeElement?.closest('.sidebar-action-slot');
      if (!menu || !anchor) return;

      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gap = 4;
      const margin = 8;
      const left = Math.max(margin, Math.min(
        anchorRect.right - menuRect.width,
        window.innerWidth - menuRect.width - margin,
      ));
      const belowTop = anchorRect.bottom + gap;
      const top = belowTop + menuRect.height <= window.innerHeight - margin
        ? belowTop
        : Math.max(margin, anchorRect.top - menuRect.height - gap);

      setPosition({ left, top });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [actions.length, footer]);

  const style: CSSProperties = position
    ? { left: position.left, top: position.top }
    : { visibility: 'hidden' };

  const menu = (
    <div ref={menuRef} className="action-menu sidebar-action-menu" style={style}>
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
    </div>
  );

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}
