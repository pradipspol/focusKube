import type { CSSProperties, ReactNode } from 'react';

type NoticeVariant = 'error' | 'warning' | 'info' | 'success';

interface Props {
  children: ReactNode;
  variant?: NoticeVariant;
  className?: string;
  style?: CSSProperties;
  as?: 'div' | 'span';
}

export function Notice({ children, variant, className, style, as = 'div' }: Props) {
  const Element = as;
  const classes = ['notice', variant, className].filter(Boolean).join(' ');

  return <Element className={classes} style={style}>{children}</Element>;
}