import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
  text: string;
  copyLabel: string;
  copiedLabel: string;
  className: string;
  iconOnly?: boolean;
}

export function CopyButton({ text, copyLabel, copiedLabel, className, iconOnly = false }: Props) {
  const [copied, setCopied] = useState(false);
  const label = copied ? copiedLabel : copyLabel;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access may be unavailable in non-secure contexts.
    }
  };

  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {iconOnly
        ? copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />
        : label}
    </button>
  );
}
