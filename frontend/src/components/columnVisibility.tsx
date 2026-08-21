import { useEffect, useState } from 'react';

export type ColumnLike = { key: string; label?: string; header?: string };

export function getAvailableColumnKeys<T extends ColumnLike>(columns: T[]): string[] {
  return columns.map((column) => column.key);
}

export function readVisibleColumnKeys<T extends ColumnLike>(columns: T[], storageKey: string): string[] {
  const defaults = getAvailableColumnKeys(columns);
  if (typeof window === 'undefined') return defaults;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const valid = parsed.filter((key): key is string => typeof key === 'string' && defaults.includes(key));
    return valid.length > 0 ? valid : defaults;
  } catch {
    return defaults;
  }
}

export function persistVisibleColumnKeys(storageKey: string, next: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey, JSON.stringify(next));
}

export function useColumnVisibility<T extends ColumnLike>(columns: T[], storageKey: string) {
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => readVisibleColumnKeys(columns, storageKey));
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const columnKeySignature = columns.map((column) => column.key).join('|');

  useEffect(() => {
    const nextVisibleColumns = readVisibleColumnKeys(columns, storageKey);
    setVisibleColumns((current) => {
      if (current.length === nextVisibleColumns.length && current.every((key, index) => key === nextVisibleColumns[index])) {
        return current;
      }
      return nextVisibleColumns;
    });
    setColumnMenuOpen(false);
  }, [columnKeySignature, storageKey]);

  const toggleVisibleColumn = (key: string) => {
    setVisibleColumns((current) => {
      const next = current.includes(key) ? current.filter((value) => value !== key) : [...current, key];
      if (next.length === 0) return current;
      persistVisibleColumnKeys(storageKey, next);
      return next;
    });
  };

  const resetVisibleColumns = () => {
    const allColumns = getAvailableColumnKeys(columns);
    persistVisibleColumnKeys(storageKey, allColumns);
    setVisibleColumns(allColumns);
  };

  return { visibleColumns, setVisibleColumns, toggleVisibleColumn, resetVisibleColumns, columnMenuOpen, setColumnMenuOpen };
}

export function ColumnVisibilityPicker<T extends ColumnLike>({
  columns,
  visibleColumns,
  onToggle,
  onReset,
  isOpen,
  onOpenChange,
}: {
  columns: T[];
  visibleColumns: string[];
  onToggle: (key: string) => void;
  onReset: () => void;
  isOpen: boolean;
  onOpenChange: (nextOpen: boolean) => void;
}) {
  return (
    <div className="column-actions-header">
      <button
        type="button"
        className="column-picker-button"
        title="Choose visible columns"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(!isOpen);
        }}
      >
        ☰
      </button>
      {isOpen && (
        <div className="column-picker-menu" role="menu" aria-label="Visible columns">
          {columns.map((column) => (
            <label key={column.key} className="column-picker-option">
              <input
                type="checkbox"
                checked={visibleColumns.includes(column.key)}
                onChange={() => onToggle(column.key)}
              />
              <span>{column.label ?? column.header ?? column.key}</span>
            </label>
          ))}
          <button
            type="button"
            className="column-picker-reset"
            onClick={() => {
              onReset();
              onOpenChange(false);
            }}
          >
            Reset Columns
          </button>
        </div>
      )}
    </div>
  );
}
