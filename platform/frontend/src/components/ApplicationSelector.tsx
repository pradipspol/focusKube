import { useMemo } from 'react';
import { uiText } from '../text';
import { SelectionDropdown } from './SelectionDropdown';

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
    <SelectionDropdown
      title={uiText.common.selectApplications}
      label={label}
      selected={selected}
      options={applications.map((app) => ({ value: app.key, label: app.label }))}
      onChange={onChange}
      allOption={applications.length > 0 ? {
        label: uiText.common.allApplications,
        checked: allSelected,
        onToggle: () => onChange(allSelected ? [] : applications.map((app) => app.key)),
      } : undefined}
      emptyMessage={uiText.common.noApplicationsFound}
    />
  );
}
