import type { ReactNode } from 'react';

export interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
}

interface Props<Value extends string> {
  value: Value;
  options: readonly SegmentedControlOption<Value>[];
  onChange: (value: Value) => void;
  groupClassName: string;
  buttonClassName?: string;
  ariaLabel?: string;
}

export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
  groupClassName,
  buttonClassName,
  ariaLabel,
}: Props<Value>) {
  return (
    <div className={groupClassName} {...(ariaLabel ? { role: 'group', 'aria-label': ariaLabel } : {})}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={[buttonClassName, option.value === value ? 'active' : ''].filter(Boolean).join(' ')}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}