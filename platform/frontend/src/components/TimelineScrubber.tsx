import { useMemo, useRef } from 'react';
import { uiText } from '../text';

export interface TimelineTick {
  ts: number;
  weight?: number;
  severity?: 'info' | 'warning' | 'error';
}

export interface TimelineMarker {
  ts: number;
  label: string;
  kind: string;
}

interface Props {
  rangeStart: number;
  rangeEnd: number;
  ticks: TimelineTick[];
  markers?: TimelineMarker[];
  value: number;
  onChange?: (ts: number) => void;
  onCommit?: (ts: number) => void;
  live?: boolean;
  onToggleLive?: (live: boolean) => void;
}

export function TimelineScrubber({
  rangeStart,
  rangeEnd,
  ticks,
  markers,
  value,
  onChange,
  onCommit,
  live,
  onToggleLive,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const densityMap = useMemo(() => {
    if (ticks.length === 0 || rangeStart === rangeEnd) return new Map<number, { weight: number; maxSeverity: string }>();

    const bucketCount = 100;
    const map = new Map<number, { weight: number; maxSeverity: string }>();
    const duration = rangeEnd - rangeStart;

    for (let i = 0; i < bucketCount; i++) {
      map.set(i, { weight: 0, maxSeverity: 'info' });
    }

    for (const tick of ticks) {
      const bucketIndex = Math.floor(((tick.ts - rangeStart) / duration) * bucketCount);
      if (bucketIndex >= 0 && bucketIndex < bucketCount) {
        const existing = map.get(bucketIndex)!;
        existing.weight += tick.weight ?? 1;
        const severityOrder = { info: 0, warning: 1, error: 2 };
        const tickSeverity = severityOrder[tick.severity ?? 'info'];
        const existingSeverity = severityOrder[existing.maxSeverity as 'info' | 'warning' | 'error'];
        if (tickSeverity > existingSeverity) {
          existing.maxSeverity = tick.severity ?? 'info';
        }
      }
    }

    return map;
  }, [ticks, rangeStart, rangeEnd]);

  const maxWeight = useMemo(() => {
    let max = 0;
    for (const { weight } of densityMap.values()) {
      if (weight > max) max = weight;
    }
    return Math.max(max, 1);
  }, [densityMap]);

  const markerPositions = useMemo(() => {
    if (!markers || rangeStart === rangeEnd) return [];
    const duration = rangeEnd - rangeStart;
    return markers
      .filter((m) => m.ts >= rangeStart && m.ts <= rangeEnd)
      .map((m) => ({
        ...m,
        percent: ((m.ts - rangeStart) / duration) * 100,
      }));
  }, [markers, rangeStart, rangeEnd]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.currentTarget.value, 10);
    onChange?.(newValue);
  };

  const handleCommit = () => {
    if (inputRef.current) {
      const newValue = parseInt(inputRef.current.value, 10);
      onCommit?.(newValue);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem', borderBottom: '1px solid var(--surface-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontWeight: 500 }}>{uiText.timeline.clusterTimeline}</label>
        {onToggleLive && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9em' }}>
            <input
              type="checkbox"
              checked={live ?? false}
              onChange={(e) => onToggleLive(e.currentTarget.checked)}
            />
            Live mode
          </label>
        )}
      </div>

      <div style={{ position: 'relative', height: '3rem' }}>
        {/* Density background */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '0.25rem',
            backgroundColor: 'var(--surface-secondary)',
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          {Array.from(densityMap.entries()).map(([bucketIdx, { weight, maxSeverity }]) => {
            const heightPercent = (weight / maxWeight) * 100;
            const colors: Record<string, string> = {
              error: 'var(--severity-error)',
              warning: 'var(--severity-warning)',
              info: 'var(--severity-info)',
            };
            return (
              <div
                key={bucketIdx}
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  borderRight: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: `${heightPercent}%`,
                    backgroundColor: colors[maxSeverity] || colors.info,
                    opacity: 0.7,
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Markers */}
        {markerPositions.length > 0 && (
          <div style={{ position: 'absolute', inset: 0 }}>
            {markerPositions.map((marker, idx) => (
              <div
                key={idx}
                title={marker.label}
                style={{
                  position: 'absolute',
                  left: `${marker.percent}%`,
                  top: 0,
                  width: '2px',
                  height: '100%',
                  backgroundColor: 'var(--text-on-accent)',
                  borderLeft: '1px solid var(--severity-warning)',
                  cursor: 'pointer',
                  opacity: 0.8,
                }}
              />
            ))}
          </div>
        )}

        {/* Range input slider */}
        <input
          ref={inputRef}
          type="range"
          min={rangeStart}
          max={rangeEnd}
          value={value}
          onChange={handleChange}
          onMouseUp={handleCommit}
          onTouchEnd={handleCommit}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: 'pointer',
            zIndex: 10,
          }}
        />

        {/* Playhead indicator */}
        {rangeEnd > rangeStart && (
          <div
            style={{
              position: 'absolute',
              left: `${((value - rangeStart) / (rangeEnd - rangeStart)) * 100}%`,
              top: 0,
              width: '2px',
              height: '100%',
              backgroundColor: 'var(--text-on-accent)',
              boxShadow: '0 0 4px var(--accent)',
              pointerEvents: 'none',
              transform: 'translateX(-50%)',
            }}
          />
        )}
      </div>

      <div style={{ fontSize: '0.85em', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
        <span>{rangeStart ? new Date(rangeStart).toLocaleString() : 'Start'}</span>
        <span>{value ? new Date(value).toLocaleString() : 'Current'}</span>
        <span>{rangeEnd ? new Date(rangeEnd).toLocaleString() : 'Now'}</span>
      </div>
    </div>
  );
}
