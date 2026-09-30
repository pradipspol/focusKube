import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export function EmptyState({ children }: Props) {
  return <div className="empty">{children}</div>;
}