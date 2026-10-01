import { ChevronRight } from 'lucide-react';

interface Props {
  collapsed: boolean;
  className?: string;
}

export function TreeDisclosure({ collapsed, className }: Props) {
  return (
    <span className={`tree-disclosure${collapsed ? ' collapsed' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <ChevronRight className="tree-disclosure-mark" size={12} aria-hidden="true" />
    </span>
  );
}