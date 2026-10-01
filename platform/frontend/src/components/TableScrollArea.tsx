import { useEffect, useState, type ReactNode, type RefObject, type UIEventHandler } from 'react';

interface Props {
  children: ReactNode;
  scrollRef: RefObject<HTMLDivElement>;
  className?: string;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

export function TableScrollArea({ children, scrollRef, className = '', onScroll }: Props) {
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const table = host.querySelector('table');
    const measure = () => {
      const nextWidth = Math.max(host.clientWidth, table?.scrollWidth ?? 0);
      setContentWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(host);
    if (table) observer?.observe(table);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [scrollRef]);

  return (
    <div className="table-scroll-shell">
      <div
        className={`data-table-wrapper ${className}`.trim()}
        ref={scrollRef}
        onScroll={(event) => {
          const scrollbar = event.currentTarget.parentElement?.querySelector<HTMLDivElement>('.table-horizontal-scrollbar');
          if (scrollbar && scrollbar.scrollLeft !== event.currentTarget.scrollLeft) {
            scrollbar.scrollLeft = event.currentTarget.scrollLeft;
          }
          onScroll?.(event);
        }}
      >
        {children}
      </div>
      {contentWidth > (scrollRef.current?.clientWidth ?? 0) + 1 && (
        <div
          className="table-horizontal-scrollbar"
          role="region"
          aria-label="Scroll table horizontally"
          tabIndex={0}
          onScroll={(event) => {
            const host = scrollRef.current;
            if (host && host.scrollLeft !== event.currentTarget.scrollLeft) {
              host.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
        >
          <div aria-hidden="true" style={{ width: contentWidth, height: 1 }} />
        </div>
      )}
    </div>
  );
}