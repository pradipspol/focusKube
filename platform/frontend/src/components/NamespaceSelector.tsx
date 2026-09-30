import { useMemo } from 'react';
import { uiText } from '../text';
import { SelectionDropdown } from './SelectionDropdown';

interface Props {
  namespaces: string[];
  selectedNamespaces: string[];
  onChange: (next: string[]) => void;
}

export function NamespaceSelector({ namespaces, selectedNamespaces, onChange }: Props) {
  const label = useMemo(() => {
    if (selectedNamespaces.length === 0) return uiText.common.allNamespaces;
    if (selectedNamespaces.length === 1) return selectedNamespaces[0];
    return `${selectedNamespaces.length} ${uiText.common.selectedNamespacesSuffix}`;
  }, [selectedNamespaces]);

  return (
    <SelectionDropdown
      title={uiText.common.selectNamespacesTitle}
      label={label}
      selected={selectedNamespaces}
      options={namespaces.map((name) => ({ value: name, label: name }))}
      onChange={onChange}
      allOption={{
        label: uiText.common.allNamespaces,
        checked: selectedNamespaces.length === 0,
        onToggle: () => onChange([]),
      }}
      searchPlaceholder={uiText.common.searchNamespaces}
      emptyMessage={uiText.common.noNamespacesFound}
      noResultsMessage={uiText.common.noNamespacesFound}
    />
  );
}