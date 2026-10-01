import type { MouseEventHandler, ReactNode } from 'react';

interface Props {
  title: string;
  ariaLabel?: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  baseClassName?: string;
  disabled?: boolean;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaHasPopup?: boolean | 'menu' | 'dialog';
}

export function IconActionButton({
  title,
  ariaLabel,
  children,
  onClick,
  className,
  baseClassName = 'drawer-action-icon',
  disabled,
  ariaPressed,
  ariaExpanded,
  ariaHasPopup,
}: Props) {
  return (
    <button
      type="button"
      className={[baseClassName, className].filter(Boolean).join(' ')}
      title={title}
      aria-label={ariaLabel ?? title}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}