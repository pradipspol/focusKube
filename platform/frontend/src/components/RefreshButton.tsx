import type { MouseEventHandler } from 'react';
import { RefreshCw } from 'lucide-react';
import { IconActionButton } from './IconActionButton';

interface Props {
  onClick: MouseEventHandler<HTMLButtonElement>;
  title: string;
  disabled?: boolean;
}

export function RefreshButton({ onClick, title, disabled }: Props) {
  return (
    <IconActionButton
      baseClassName="toolbar-icon-action toolbar-refresh"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <RefreshCw aria-hidden="true" />
    </IconActionButton>
  );
}