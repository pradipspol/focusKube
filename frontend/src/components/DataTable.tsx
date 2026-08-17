import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEventHandler,
  type ReactNode,
} from 'react';

export interface DataColumn<T> {
  key: string;
  header: string;
  /** Value used for sorting and as the default cell text. */
  value: (row: T) => string | number;
  /** Optional custom cell renderer (falls back to `value`). */
  render?: (row: T) => ReactNode;
  width?: number;
  /** Defaults to true. */
  sortable?: boolean;
  /** Defaults to true. */
  resizable?: boolean;
  className?: string;
}

export interface DataAction<T> {
  label: string;
  onClick: (row: T) => void;
  danger?: boolean;
  disabled?: (row: T) => boolean;
}

interface DataTableProps<T> {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  rowClick?: (row: T) => void;
  /** When provided, the row gets an actions menu whose first item is "Show details". */
  onShowDetails?: (row: T) => void;
  /** Extra actions appended after "Show details". */
  actions?: DataAction<T>[];
  /** Optional default sort column key. */
  initialSortKey?: string;
  /** Render a leading select-all / per-row checkbox column. */
  selectable?: boolean;
  /** Notified with the currently selected rows whenever the selection changes. */
  onSelectionChange?: (rows: T[]) => void;
  /** Optional scroll handler for the table host. */
  onScroll?: UIEventHandler<HTMLDivElement>;
  /** Optional initial sort direction. Defaults to ascending. */
  initialSortDirection?: SortDir;
}

type SortDir = 'asc' | 'desc';

const SELECT_KEY = '__select';
const ACTIONS_KEY = '__actions';
const SELECT_WIDTH = 40;
const ACTIONS_WIDTH = 64;

/**
 * Generic data table with sortable + resizable themed headers, optional row
 * selection, an actions menu (always led by "Show details"), and auto-fit so
 * columns fill the viewport without a horizontal scrollbar on load.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowClassName,
  rowClick,
  onShowDetails,
  actions = [],
  initialSortKey,
  selectable = false,
  onSelectionChange,
  onScroll,
  initialSortDirection = 'asc',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string>(initialSortKey ?? columns[0]?.key ?? '');
  const [sortDir, setSortDir] = useState<SortDir>(initialSortDirection);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const [hasManualResize, setHasManualResize] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const hasActions = !!onShowDetails || actions.length > 0;
  const colSignature = columns.map((c) => `${c.key}:${c.width ?? ''}`).join('|');

  useEffect(() => {
    setSortDir(initialSortDirection);
  }, [initialSortDirection]);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col || col.sortable === false) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, columns, sortKey, sortDir]);

  // ---- Auto-fit columns to the available width (unless manually resized) ----
  useEffect(() => {
    if (hasManualResize) return;

    const fit = () => {
      const host = wrapperRef.current;
      if (!host) return;
      const available = host.clientWidth - 2;
      if (available <= 0) return;

      const layout = [
        ...(selectable ? [{ key: SELECT_KEY, base: SELECT_WIDTH, floor: SELECT_WIDTH }] : []),
        ...columns.map((c) => ({ key: c.key, base: c.width ?? 120, floor: 56 })),
        ...(hasActions ? [{ key: ACTIONS_KEY, base: ACTIONS_WIDTH, floor: 48 }] : []),
      ];
      const totalBase = layout.reduce((sum, c) => sum + c.base, 0);
      if (totalBase <= available) {
        setAutoWidths({});
        return;
      }

      const totalFloor = layout.reduce((sum, c) => sum + c.floor, 0);
      const next: Record<string, number> = {};
      if (totalFloor >= available) {
        layout.forEach((c) => {
          next[c.key] = c.floor;
        });
      } else {
        const slack = available - totalFloor;
        let used = 0;
        layout.forEach((c) => {
          next[c.key] = c.floor + Math.floor((c.base / totalBase) * slack);
          used += next[c.key];
        });
        const fillKey = columns[0]?.key ?? layout[0].key;
        next[fillKey] += available - used;
      }
      setAutoWidths(next);
    };

    fit();
    const rafId = window.requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', fit);
    };
  }, [colSignature, rows.length, selectable, hasActions, hasManualResize]);

  const colWidth = (key: string, fallback?: number) => widths[key] ?? autoWidths[key] ?? fallback;

  const toggleSort = (col: DataColumn<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
  };

  const startResize = (key: string, startWidth: number, startX: number) => {
    setHasManualResize(true);
    const onMove = (e: MouseEvent) => {
      const next = Math.max(60, startWidth + e.clientX - startX);
      setWidths((cur) => ({ ...cur, [key]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const emitSelection = (next: Set<string>) => {
    setSelected(next);
    onSelectionChange?.(rows.filter((r) => next.has(rowKey(r))));
  };

  const toggleRow = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    emitSelection(next);
  };

  const allKeys = rows.map(rowKey);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected = !allSelected && allKeys.some((k) => selected.has(k));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = () => {
    if (allSelected) {
      const next = new Set(selected);
      allKeys.forEach((k) => next.delete(k));
      emitSelection(next);
    } else {
      emitSelection(new Set([...selected, ...allKeys]));
    }
  };

  const openMenu = (key: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const count = (onShowDetails ? 1 : 0) + actions.length;
    const estimatedHeight = Math.min(count * 34 + 18, 260);
    const estimatedWidth = 220;
    const up = window.innerHeight - rect.bottom < estimatedHeight + 8;
    setMenuPos({
      top: up ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(8, Math.min(window.innerWidth - estimatedWidth - 8, rect.right - estimatedWidth)),
      up,
    });
    setOpenKey((cur) => (cur === key ? null : key));
  };

  useEffect(() => {
    if (!openKey) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('.action-menu') || target.closest('.action-trigger'))) return;
      setOpenKey(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [openKey]);

  return (
    <div className="data-table-wrapper" ref={wrapperRef} onScroll={onScroll}>
      <table className="data-table">
        <colgroup>
          {selectable && <col style={{ width: colWidth(SELECT_KEY, SELECT_WIDTH) }} />}
          {columns.map((c) => (
            <col key={c.key} style={{ width: colWidth(c.key, c.width) }} />
          ))}
          {hasActions && <col style={{ width: colWidth(ACTIONS_KEY, ACTIONS_WIDTH) }} />}
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <th className="select-cell">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  title="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((c) => {
              const sortable = c.sortable !== false;
              const resizable = c.resizable !== false;
              return (
                <th key={c.key}>
                  <div
                    className={`th-content ${sortable ? 'sortable' : ''}`}
                    title={sortable ? 'Click to sort' : ''}
                    onClick={() => toggleSort(c)}
                  >
                    <span className={sortable ? 'th-sort-label sortable' : 'th-sort-label'}>
                      {c.header}
                      {sortable && sortKey === c.key && (
                        <span className="th-sort-indicator">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                      )}
                    </span>
                    {resizable && (
                      <span
                        className="col-resizer"
                        title={`Resize ${c.header} column`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          startResize(c.key, colWidth(c.key, c.width ?? 120) ?? 120, event.clientX);
                        }}
                      />
                    )}
                  </div>
                </th>
              );
            })}
            {hasActions && <th aria-label="Actions"></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const extraRowClassName = rowClassName?.(row);
            return (
              <tr
                key={key}
                className={`${extraRowClassName ?? ''} ${rowClick ? 'clickable-row' : ''}`.trim()}
                onClick={rowClick ? () => rowClick(row) : undefined}
              >
                {selectable && (
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      title="Select row"
                      checked={selected.has(key)}
                      onChange={() => toggleRow(key)}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.render ? c.render(row) : c.value(row)}
                  </td>
                ))}
                {hasActions && (
                  <td className={`actions-cell ${openKey === key ? 'menu-open' : ''}`}>
                    <div className="row-actions row-actions-visible">
                      <button className="action-trigger" title="Actions" onClick={(event) => openMenu(key, event)}>
                        ⋮
                      </button>
                      {openKey === key && menuPos && (
                        <div
                          className={`action-menu ${menuPos.up ? 'open-up' : ''}`}
                          style={{ top: menuPos.top, left: menuPos.left }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {onShowDetails && (
                            <button
                              className="action-menu-item"
                              onClick={() => {
                                setOpenKey(null);
                                onShowDetails(row);
                              }}
                            >
                              Show details
                            </button>
                          )}
                          {actions.map((action) => (
                            <button
                              key={action.label}
                              className={`action-menu-item ${action.danger ? 'danger' : ''}`}
                              disabled={action.disabled?.(row)}
                              onClick={() => {
                                setOpenKey(null);
                                action.onClick(row);
                              }}
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
