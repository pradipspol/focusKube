import { useEffect, useMemo, useRef, useState } from 'react';

export interface ApplicationOption {
  key: string;
  label: string;
}

interface Props {
  applications: ApplicationOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}

// Unlike NamespaceSelector, an empty selection here means "show nothing" — the
// topology graph should stay blank until the user actively opts into an application.
export function ApplicationSelector({ applications, selected, onChange }: Props) {
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

  const allSelected = applications.length > 0 && selected.length === applications.length;

  const label = useMemo(() => {
    if (selected.length === 0) return 'Select applications…';
    if (allSelected) return 'All applications';
    if (selected.length === 1) {
      return applications.find((app) => app.key === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} selected`;
  }, [allSelected, applications, selected]);

  return (
    <div className="namespace-toolbar">
      <div className="namespace-dropdown" ref={dropdownRef}>
        <button
          className="namespace-dropdown-trigger"
          title="Select applications"
          onClick={() => setOpen((current) => !current)}
        >
          <span>{label}</span>
          <span>{open ? '▴' : '▾'}</span>
        </button>
        {open && (
          <div className="namespace-dropdown-menu">
            {applications.length === 0 && <div className="namespace-option dim">No applications found.</div>}
            {applications.length > 0 && (
              <label className="namespace-option">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onChange(allSelected ? [] : applications.map((app) => app.key))}
                />
                <span>All applications</span>
              </label>
            )}
            {applications.map((app) => {
              const checked = selected.includes(app.key);
              return (
                <label key={app.key} className="namespace-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      if (checked) {
                        onChange(selected.filter((item) => item !== app.key));
                      } else {
                        onChange([...selected, app.key]);
                      }
                    }}
                  />
                  <span>{app.label}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
