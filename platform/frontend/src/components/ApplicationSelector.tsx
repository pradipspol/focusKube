import { useEffect, useMemo, useRef, useState } from 'react';
import { uiText } from '../text';
import { TreeDisclosure } from './TreeDisclosure';

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
export function ApplicationSelector ({ applications, selected, onChange }: Props) {
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
    if (selected.length === 0) return uiText.common.selectApplications;
    if (allSelected) return uiText.common.allApplications;
    if (selected.length === 1) {
      return applications.find((app) => app.key === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} ${uiText.common.selectedCountSuffix}`;
  }, [allSelected, applications, selected]);

  return (
    <div className="namespace-toolbar">
      <div className="namespace-dropdown" ref={dropdownRef}>
        <button
          className="namespace-dropdown-trigger"
          title={uiText.common.selectApplications}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{label}</span>
          <TreeDisclosure collapsed={!open} />
        </button>
        {open && (
          <div className="namespace-dropdown-menu">
            {applications.length === 0 && <div className="namespace-option dim">{uiText.common.noApplicationsFound}</div>}
            {applications.length > 0 && (
              <label className="namespace-option">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onChange(allSelected ? [] : applications.map((app) => app.key))}
                />
                <span>{uiText.common.allApplications}</span>
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
