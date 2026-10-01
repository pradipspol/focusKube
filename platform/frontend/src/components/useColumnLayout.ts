import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

export interface ColumnLayoutItem {
  key: string;
  width: number;
  minWidth: number;
}

interface Options {
  hostRef: RefObject<HTMLElement | null>;
  columns: ColumnLayoutItem[];
  fillKey?: string;
  fitKey: string | number;
}

export function useColumnLayout({ hostRef, columns, fillKey, fitKey }: Options) {
  const [manualWidths, setManualWidths] = useState<Record<string, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const [hasManualResize, setHasManualResize] = useState(false);
  const columnSignature = useMemo(
    () => columns.map((column) => `${column.key}:${column.width}:${column.minWidth}`).join('|'),
    [columns],
  );

  useEffect(() => {
    if (hasManualResize) return;

    const fit = () => {
      const host = hostRef.current;
      if (!host) return;
      const available = host.clientWidth - 2;
      if (available <= 0) return;

      const totalBase = columns.reduce((sum, column) => sum + column.width, 0);
      if (totalBase <= available) {
        setAutoWidths({});
        return;
      }

      const totalFloor = columns.reduce((sum, column) => sum + column.minWidth, 0);
      const next: Record<string, number> = {};
      if (totalFloor >= available) {
        columns.forEach((column) => {
          next[column.key] = column.minWidth;
        });
      } else {
        const slack = available - totalFloor;
        let used = 0;
        columns.forEach((column) => {
          next[column.key] = column.minWidth + Math.floor((column.width / totalBase) * slack);
          used += next[column.key];
        });
        const targetKey = fillKey ?? columns[0]?.key;
        if (targetKey) next[targetKey] = (next[targetKey] ?? 0) + available - used;
      }
      setAutoWidths(next);
    };

    fit();
    const frame = window.requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    if (hostRef.current) observer.observe(hostRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [columnSignature, columns, fillKey, fitKey, hasManualResize, hostRef]);

  const widthFor = (key: string, fallback?: number) => manualWidths[key] ?? autoWidths[key] ?? fallback;

  const startResize = (key: string, startWidth: number, startX: number) => {
    setHasManualResize(true);
    const onMove = (event: MouseEvent) => {
      setManualWidths((current) => ({ ...current, [key]: Math.max(60, startWidth + event.clientX - startX) }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const reset = useCallback(() => {
    setManualWidths({});
    setAutoWidths({});
    setHasManualResize(false);
  }, []);

  return { hasManualResize, reset, startResize, widthFor };
}