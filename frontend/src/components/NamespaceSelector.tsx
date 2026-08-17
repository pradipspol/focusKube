import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  namespaces: string[];
  selectedNamespaces: string[];
  onChange: (next: string[]) => void;
}

export function NamespaceSelector({ namespaces, selectedNamespaces, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const label = useMemo(() => {
    if (selectedNamespaces.length === 0) return 'All namespaces';
    if (selectedNamespaces.length === 1) return selectedNamespaces[0];
    return `${selectedNamespaces.length} selected`;
  }, [selectedNamespaces]);

  return (
    <div className="namespace-toolbar">
      <div className="namespace-dropdown" ref={dropdownRef}>
        <button
          className="namespace-dropdown-trigger"
          title="Select namespaces"
          onClick={() => setOpen((current) => !current)}
        >
          <span>{label}</span>
          <span>{open ? '▴' : '▾'}</span>
        </button>
        {open && (
          <div className="namespace-dropdown-menu">
            <label className="namespace-option">
              <input type="checkbox" checked={selectedNamespaces.length === 0} onChange={() => onChange([])} />
              <span>All namespaces</span>
            </label>
            {namespaces.map((name) => {
              const checked = selectedNamespaces.includes(name);
              return (
                <label key={name} className="namespace-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      if (checked) {
                        onChange(selectedNamespaces.filter((item) => item !== name));
                      } else {
                        onChange([...selectedNamespaces, name]);
                      }
                    }}
                  />
                  <span>{name}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}