import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Scope } from '../../api/client';
import type { ChangeEventDoc } from '../../api/types';
import type { DataColumn } from '../DataTable';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { useObservabilityWs } from '../../lib/useObservabilityWs';
import { uiText } from '../../text';

interface Props {
  scope: Scope;
}

const TIME_RANGE_PRESETS = [
  { label: 'Live', value: 'live' },
  { label: '15 min', value: '15min' },
  { label: '1 hour', value: '1h' },
  { label: '1 day', value: '1d' },
  { label: '7 days', value: '7d' },
];

export function CorrelationDashboard({ scope }: Props) {
  const [timeRange, setTimeRange] = useState('1h');
  const [showDetailsFor, setShowDetailsFor] = useState<ChangeEventDoc | null>(null);
  const [liveEvents, setLiveEvents] = useState<ChangeEventDoc[]>([]);

  const { subscribe } = useObservabilityWs(scope.context);

  if (!scope.context) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="notice">{uiText.observability.selectContext}</div>
      </div>
    );
  }

  const { from, to } = useMemo(() => {
    const now = new Date();
    let from = new Date();

    switch (timeRange) {
      case 'live':
        from = new Date(now.getTime() - 10 * 60 * 1000);
        break;
      case '15min':
        from = new Date(now.getTime() - 15 * 60 * 1000);
        break;
      case '1h':
        from = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '1d':
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
    }

    return { from, to: now };
  }, [timeRange]);

  // Load historical correlation data once when time range changes, don't auto-refetch
  const { data: historicalEvents = [] } = useQuery({
    queryKey: ['observability', 'correlation', scope.context, from.getTime(), to.getTime()],
    queryFn: () => api.observabilityCorrelation(scope, { from, to }),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  // Subscribe to real-time WebSocket events
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === 'event') {
        setLiveEvents((prev) => [...prev, message.data]);
      }
    });
    return unsubscribe;
  }, [subscribe]);

  // Combine historical and live events, preserving every record.
  const events = useMemo(() => {
    const result: ChangeEventDoc[] = [];
    const fromTime = from.getTime();
    const toTime = to.getTime();

    for (const e of historicalEvents) {
      const eventTime = new Date(e.ts).getTime();
      if (eventTime >= fromTime && eventTime <= toTime) result.push(e);
    }

    for (const e of liveEvents) {
      const eventTime = new Date(e.ts).getTime();
      if (eventTime >= fromTime && eventTime <= toTime) result.push(e);
    }

    return result;
  }, [historicalEvents, liveEvents, from, to]);

  const columns: DataColumn<ChangeEventDoc>[] = [
    { key: 'ts', header: 'Time', value: (row) => new Date(row.ts).toLocaleString(), width: 180 },
    { key: 'severity', header: 'Severity', value: (row) => row.severity, width: 100 },
    { key: 'kind', header: 'Kind', value: (row) => row.kind, width: 120 },
    { key: 'namespace', header: 'Namespace', value: (row) => row.namespace || '(cluster)', width: 120 },
    { key: 'name', header: 'Name', value: (row) => row.name, width: 150 },
    { key: 'summary', header: 'Summary', value: (row) => row.summary },
  ];

  const workloadChanges = useMemo(() => {
    return events.filter((e: ChangeEventDoc) => e.category === 'workloadChange').length;
  }, [events]);

  const warningEvents = useMemo(() => {
    return events.filter((e: ChangeEventDoc) => e.category === 'k8sEvent' && e.severity === 'warning').length;
  }, [events]);

  const correlatedEvents = useMemo(() => {
    return events.filter((e: ChangeEventDoc) => e.correlatedWith).length;
  }, [events]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div className="toolbar" style={{ borderBottom: '1px solid var(--surface-border)' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <label>
            <strong>{uiText.observability.timeRange}</strong>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.currentTarget.value)}
              style={{ marginLeft: '0.5rem', padding: '0.25rem' }}
            >
              {TIME_RANGE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: '2rem', fontSize: '0.9em', marginLeft: '2rem' }}>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{uiText.observability.workloadChanges}</span>
            <strong style={{ marginLeft: '0.5rem', color: 'var(--severity-info)' }}>{workloadChanges}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{uiText.observability.warningEvents}</span>
            <strong style={{ marginLeft: '0.5rem', color: 'var(--severity-warning)' }}>{warningEvents}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-secondary)' }}>{uiText.observability.correlated}</span>
            <strong style={{ marginLeft: '0.5rem', color: 'var(--ok)' }}>{correlatedEvents}</strong>
          </div>
        </div>
      </div>

      {/* Events table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {events.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            {uiText.observability.noEventsInRange}
          </div>
        ) : (
          <DataTable
            rowKey={(row) => row.uid || `${row.kind}/${row.namespace}/${row.name}`}
            columns={columns}
            rows={events}
            initialSortKey="ts"
            onShowDetails={(row) => setShowDetailsFor(row)}
            rowClassName={(row: ChangeEventDoc) => {
              if (row.category === 'k8sEvent' && row.severity === 'warning') return 'row-warning';
              if (row.category === 'k8sEvent' && row.severity === 'error') return 'row-error';
              if (row.category === 'workloadChange') return 'row-info';
              return '';
            }}
          />
        )}
      </div>

      {/* Detail modal */}
      {showDetailsFor && (
        <Modal
          title={`${showDetailsFor.kind} ${showDetailsFor.name}`}
          onClose={() => setShowDetailsFor(null)}
        >
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <strong>{uiText.observability.time}</strong> {new Date(showDetailsFor.ts).toLocaleString()}
            </div>
            <div>
              <strong>{uiText.observability.namespace}</strong> {showDetailsFor.namespace || '(cluster-scoped)'}
            </div>
            <div>
              <strong>{uiText.observability.category}</strong> <code>{showDetailsFor.category}</code>
            </div>
            <div>
              <strong>{uiText.observability.changeType}</strong> <code>{showDetailsFor.changeType}</code>
            </div>
            <div>
              <strong>{uiText.observability.severity}</strong> <span className={`badge severity-${showDetailsFor.severity}`}>{showDetailsFor.severity}</span>
            </div>
            <div>
              <strong>{uiText.observability.summary}</strong> {showDetailsFor.summary}
            </div>

            {showDetailsFor.correlatedWith && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: 'var(--success-soft)',
                  color: 'var(--ok)',
                  borderRadius: '0.25rem',
                  marginTop: '0.5rem',
                }}
              >
                <strong>⊙ {uiText.observability.correlation}</strong> This event occurred {showDetailsFor.correlatedWith.minutesBefore} minutes after{' '}
                <strong>
                  {showDetailsFor.correlatedWith.kind} {showDetailsFor.correlatedWith.name}
                </strong>{' '}
                ({showDetailsFor.correlatedWith.changeType}) in{' '}
                <strong>{showDetailsFor.correlatedWith.namespace || '(cluster)'}</strong>.
              </div>
            )}

            {showDetailsFor.reason && (
              <div>
                <strong>{uiText.observability.reason}</strong> {showDetailsFor.reason}
              </div>
            )}

            {showDetailsFor.involvedObject && (
              <div>
                <strong>{uiText.observability.involvedObject}</strong> {showDetailsFor.involvedObject.kind} {showDetailsFor.involvedObject.name}
                {showDetailsFor.involvedObject.namespace && ` (${showDetailsFor.involvedObject.namespace})`}
              </div>
            )}

            {showDetailsFor.before && (
              <div>
                <strong>{uiText.observability.before}</strong>
                <pre style={{ backgroundColor: 'var(--surface-secondary)', padding: '0.5rem', borderRadius: '0.25rem', overflow: 'auto' }}>
                  {JSON.stringify(showDetailsFor.before, null, 2)}
                </pre>
              </div>
            )}

            {showDetailsFor.after && (
              <div>
                <strong>{uiText.observability.after}</strong>
                <pre style={{ backgroundColor: 'var(--surface-secondary)', padding: '0.5rem', borderRadius: '0.25rem', overflow: 'auto' }}>
                  {JSON.stringify(showDetailsFor.after, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
