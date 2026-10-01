import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEventHandler,
  type ReactNode,
} from 'react';
import { ColumnVisibilityPicker, useColumnVisibility } from './columnVisibility';
import { AnchoredMenu } from './AnchoredMenu';
import { uiText } from '../text';
import { ActionMenuTrigger } from './ActionMenuTrigger';
import { useColumnLayout } from './useColumnLayout';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TableScrollArea } from './TableScrollArea';
import { ArrowDown, ArrowUp } from 'lucide-react';

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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const hasActions = !!onShowDetails || actions.length > 0;
  const showColumnPicker = true;
  const storageKey = `k8sExplorer.dataTableColumns.${columns.map((c) => c.key).join('|')}`;
  const { visibleColumns, toggleVisibleColumn, resetVisibleColumns, columnMenuOpen, setColumnMenuOpen } = useColumnVisibility(columns, storageKey);

  const displayColumns = useMemo(
    () => columns.filter((column) => visibleColumns.includes(column.key)),
    [columns, visibleColumns],
  );
  const widthLayout = useMemo(() => [
    ...(selectable ? [{ key: SELECT_KEY, width: SELECT_WIDTH, minWidth: SELECT_WIDTH }] : []),
    ...columns.map((column) => ({ key: column.key, width: column.width ?? 120, minWidth: 56 })),
    ...(hasActions || showColumnPicker ? [{ key: ACTIONS_KEY, width: ACTIONS_WIDTH, minWidth: 48 }] : []),
  ], [columns, hasActions, selectable, showColumnPicker]);
  const { hasManualResize, startResize, widthFor: colWidth } = useColumnLayout({
    hostRef: wrapperRef,
    columns: widthLayout,
    fillKey: columns[0]?.key,
    fitKey: rows.length,
  });

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
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => wrapperRef.current,
    estimateSize: () => 40,
    getItemKey: (index) => rowKey(sorted[index]),
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  const toggleSort = (col: DataColumn<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
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
    menuAnchorRef.current = event.currentTarget as HTMLElement;
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

  useEffect(() => {
    if (!columnMenuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('.column-picker-button') || target.closest('.column-picker-menu'))) return;
      setColumnMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [columnMenuOpen]);

  return (
    <TableScrollArea scrollRef={wrapperRef} onScroll={onScroll}>
      <table className="data-table">
        <colgroup>
          {selectable && <col style={{ width: colWidth(SELECT_KEY, SELECT_WIDTH) }} />}
          {displayColumns.map((c) => (
            <col key={c.key} style={{ width: colWidth(c.key, c.width) }} />
          ))}
          {(hasActions || showColumnPicker) && <col style={{ width: colWidth(ACTIONS_KEY, ACTIONS_WIDTH) }} />}
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <th className="select-cell">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  title={uiText.common.selectAll}
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
            )}
            {displayColumns.map((c) => {
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
                        <span className="th-sort-indicator" aria-hidden="true">{sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</span>
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
            {(hasActions || showColumnPicker) && (
                  <th aria-label={uiText.common.actions}>
                <ColumnVisibilityPicker
                  columns={columns}
                  visibleColumns={visibleColumns}
                  onToggle={toggleVisibleColumn}
                  onReset={resetVisibleColumns}
                  isOpen={columnMenuOpen}
                  onOpenChange={setColumnMenuOpen}
                />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {virtualRows[0]?.start > 0 && (
            <tr aria-hidden="true">
              <td colSpan={displayColumns.length + Number(selectable) + Number(hasActions || showColumnPicker)} style={{ height: virtualRows[0].start, padding: 0, border: 0 }} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => {
            const row = sorted[virtualRow.index];
            const key = rowKey(row);
            const extraRowClassName = rowClassName?.(row);
            return (
              <tr
                key={key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className={`${extraRowClassName ?? ''} ${rowClick ? 'clickable-row' : ''}`.trim()}
                onClick={rowClick ? () => rowClick(row) : undefined}
              >
                {selectable && (
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      title={uiText.common.selectRow}
                      checked={selected.has(key)}
                      onChange={() => toggleRow(key)}
                    />
                  </td>
                )}
                {displayColumns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.render ? c.render(row) : c.value(row)}
                  </td>
                ))}
                {(hasActions || showColumnPicker) && (
                  <td className={hasActions ? `actions-cell ${openKey === key ? 'menu-open' : ''}` : 'table-column-picker-spacer'}>
                    {hasActions ? (
                      <div className="row-actions row-actions-visible">
                        <ActionMenuTrigger label={uiText.common.actions} onClick={(event) => openMenu(key, event)} />
                        {openKey === key && menuAnchorRef.current && (
                          <AnchoredMenu anchorRef={menuAnchorRef} ariaLabel={uiText.common.actions}>
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
                          </AnchoredMenu>
                        )}
                      </div>
                    ) : null}
                  </td>
                )}
              </tr>
            );
          })}
          {virtualRows.length > 0 && rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={displayColumns.length + Number(selectable) + Number(hasActions || showColumnPicker)}
                style={{ height: rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end, padding: 0, border: 0 }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </TableScrollArea>
  );
}
