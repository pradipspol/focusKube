interface Props {
  label?: string;
  hidden?: boolean;
}

export function Spinner({ label, hidden }: Props) {
  return <span className="tiny-spinner" aria-label={label} aria-hidden={hidden} />;
}
