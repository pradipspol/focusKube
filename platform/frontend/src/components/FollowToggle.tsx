interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className?: string;
}

export function FollowToggle({ checked, onChange, label, className }: Props) {
  return (
    <label className={['field', className].filter(Boolean).join(' ')}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}