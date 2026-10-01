import type { ReactNode } from 'react';

interface Props {
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  className?: string;
}

export function DrawerShell({ onClose, header, children, className = '' }: Props) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className={`drawer ${className}`.trim()} onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">{header}</div>
        {children}
      </div>
    </div>
  );
}