import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  anchorRef?: RefObject<HTMLElement>;
  anchorSelector?: string;
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
}

export function AnchoredMenu({ anchorRef, anchorSelector, ariaLabel, children, className = '' }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; caretX: number; maxHeight: number; openUp: boolean } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef?.current
        ?? (anchorSelector ? document.activeElement?.closest(anchorSelector) : null);
      const menu = menuRef.current;
      if (!anchor || !menu) return;

      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const triggerCenter = anchorRect.left + anchorRect.width / 2;
      const caretInsetFromRight = 18;
      const left = Math.max(margin, Math.min(
        triggerCenter - menuRect.width + caretInsetFromRight,
        window.innerWidth - menuRect.width - margin,
      ));
      const availableAbove = Math.max(0, anchorRect.top - gap - margin);
      const availableBelow = Math.max(0, window.innerHeight - anchorRect.bottom - gap - margin);
      const openUp = menu.scrollHeight > availableBelow && availableAbove > availableBelow;
      const maxHeight = openUp ? availableAbove : availableBelow;
      const menuHeight = Math.min(menu.scrollHeight, maxHeight);
      const top = openUp
        ? Math.max(margin, anchorRect.top - gap - menuHeight)
        : anchorRect.bottom + gap;
      const caretX = Math.max(12, Math.min(triggerCenter - left, menuRect.width - 12));

      setPosition({ left, top, caretX, maxHeight, openUp });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, anchorSelector]);

  const style: CSSProperties = position
    ? {
        left: position.left,
        top: position.top,
        '--anchored-menu-caret-x': `${position.caretX}px`,
        '--anchored-menu-max-height': `${position.maxHeight}px`,
      } as CSSProperties
    : { visibility: 'hidden' };

  const menu = (
    <div
      ref={menuRef}
      data-anchored-menu="true"
      className={`action-menu anchored-menu ${position?.openUp ? 'open-up' : ''} ${className}`.trim()}
      style={style}
      role="menu"
      aria-label={ariaLabel}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="anchored-menu-content">{children}</div>
    </div>
  );

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}