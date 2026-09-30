import type { MouseEventHandler } from 'react';

interface Props {
  orientation: 'horizontal' | 'vertical';
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  label: string;
  title: string;
}

export function PanelResizer({ orientation, onMouseDown, label, title }: Props) {
  return (
    <div
      className="panel-resizer"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title={title}
    />
  );
}