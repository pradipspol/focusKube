import { useEffect, useRef, useState } from 'react';
import { AnchoredMenu } from './AnchoredMenu';
import { TreeDisclosure } from './TreeDisclosure';

export interface SelectionDropdownOption {
  value: string;
  label: string;
}

interface Props {
  id?: string;
  title: string;
  label: string;
  selected: string[];
  options: SelectionDropdownOption[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  wrapperClassName?: string;
  allOption?: {
    label: string;
    checked: boolean;
    onToggle: () => void;
  };
  emptyOptionLabel?: string;
  emptyMessage?: string;
  searchPlaceholder?: string;
  noResultsMessage?: string;
}

export function SelectionDropdown({
  id,
  title,
  label,
  selected,
  options,
  onChange,
  multiple = true,
  wrapperClassName = 'namespace-toolbar',
  allOption,
  emptyOptionLabel,
  emptyMessage,
  searchPlaceholder,
  noResultsMessage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchTerm = search.trim().toLocaleLowerCase();
  const filteredOptions = searchTerm
    ? options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes(searchTerm))
    : options;

  useEffect(() => {
    if (!open) return;
    if (searchPlaceholder) searchRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !dropdownRef.current?.contains(target) && !target.closest('.namespace-dropdown-menu')) {
        setOpen(false);
        setSearch('');
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      setSearch('');
      triggerRef.current?.focus();
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggleOption = (value: string) => {
    const isSelected = selected.includes(value);
    if (multiple) {
      onChange(isSelected ? selected.filter((item) => item !== value) : [...selected, value]);
      return;
    }

    onChange(isSelected ? [] : [value]);
    setOpen(false);
    setSearch('');
  };

  return (
    <div className={wrapperClassName}>
      <div className="namespace-dropdown" ref={dropdownRef}>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className="namespace-dropdown-trigger"
          title={title}
          aria-label={title}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => {
            const next = !current;
            if (!next) setSearch('');
            return next;
          })}
        >
          <span>{label}</span>
          <span ref={iconRef} className="namespace-dropdown-icon-anchor">
            <TreeDisclosure collapsed={!open} />
          </span>
        </button>
        {open && (
          <AnchoredMenu anchorRef={iconRef} ariaLabel={title} className="namespace-dropdown-menu">
            {searchPlaceholder && (
              <input
                ref={searchRef}
                type="search"
                className="namespace-dropdown-search"
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
            <div className="namespace-dropdown-options">
              {allOption && (
                <label className="namespace-option">
                  <input type="checkbox" checked={allOption.checked} onChange={allOption.onToggle} />
                  <span>{allOption.label}</span>
                </label>
              )}
              {emptyOptionLabel && (
                <button
                  type="button"
                  className="namespace-option namespace-option-single"
                  role="menuitemradio"
                  aria-checked={selected.length === 0}
                  onClick={() => {
                    onChange([]);
                    setOpen(false);
                  }}
                >
                  {emptyOptionLabel}
                </button>
              )}
              {filteredOptions.map((option) => {
                const checked = selected.includes(option.value);
                return multiple ? (
                  <label key={option.value} className="namespace-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOption(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ) : (
                  <button
                    key={option.value}
                    type="button"
                    className="namespace-option namespace-option-single"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={() => toggleOption(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
              {filteredOptions.length === 0 && (emptyMessage || noResultsMessage) && (
                <div className="namespace-option dim" role="status">
                  {searchTerm ? noResultsMessage ?? emptyMessage : emptyMessage ?? noResultsMessage}
                </div>
              )}
            </div>
          </AnchoredMenu>
        )}
      </div>
    </div>
  );
}
