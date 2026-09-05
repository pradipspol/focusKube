interface Props {
  collapsed: boolean;
  className?: string;
}

export function TreeDisclosure({ collapsed, className }: Props) {
  return (
    <span className={`tree-disclosure${collapsed ? ' collapsed' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span className="tree-disclosure-mark" />
    </span>
  );
}