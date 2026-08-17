import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Scope } from '../../api/client';
import type { ChangeEventDoc } from '../../api/types';
import type { DataColumn } from '../DataTable';
import { TimelineScrubber, type TimelineMarker } from '../TimelineScrubber';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { useObservabilityWs } from '../../lib/useObservabilityWs';

interface Props {
  scope: Scope;
}

export function TimelinePanel({ scope }: Props) {
  const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
  const [showDetailsFor, setShowDetailsFor] = useState<ChangeEventDoc | null>(null);
  const [liveEvents, setLiveEvents] = useState<ChangeEventDoc[]>([]);
  const [stateAt, setStateAt] = useState<ChangeEventDoc[]>([]);

  const { subscribe, requestStateAt } = useObservabilityWs(scope.context);

  if (!scope.context) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="notice">Please select a Kubernetes context from the sidebar to view the timeline.</div>
      </div>
    );
  }

  // Calculate once on mount, not on every render
  const dayAgo = useMemo(() => Date.now() - 24 * 60 * 60 * 1000, []);
  const now = useMemo(() => Date.now(), []);

  // Load historical events once on mount, don't refetch
  const { data: historicalEvents = [] } = useQuery({
    queryKey: ['observability', 'events', scope.context, 'historical'],
    queryFn: () =>
      api.observabilityEvents(scope, {
        from: new Date(dayAgo),
        to: new Date(now),
      }),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Subscribe to real-time WebSocket events
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === 'event') {
        setLiveEvents((prev) => [...prev, message.data]);
      } else if (message.type === 'state') {
        setStateAt(message.data || []);
      }
    });
    return unsubscribe;
  }, [subscribe]);

  // When scrubber is released, request state-at via WebSocket
  const handleScrubberCommit = (ts: number) => {
    requestStateAt(new Date(ts));
  };

  // Combine historical and live events, deduplicating by uid
  const allEvents = useMemo(() => {
    const seen = new Set<string>();
    const result: ChangeEventDoc[] = [];

    // Add historical events first
    for (const event of historicalEvents) {
      const key = event.uid || event.name;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(event);
      }
    }

    // Add live events that aren't already in historical
    for (const event of liveEvents) {
      const key = event.uid || event.name;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(event);
      }
    }

    return result;
  }, [historicalEvents, liveEvents]);

  const ticks = useMemo(() => {
    return allEvents.map((e: ChangeEventDoc) => ({
      ts: new Date(e.ts).getTime(),
      weight: 1,
      severity: e.severity as 'info' | 'warning' | 'error',
    }));
  }, [allEvents]);

  const markers = useMemo(() => {
    return allEvents
      .filter((e: ChangeEventDoc) => e.category === 'workloadChange')
      .map((e: ChangeEventDoc) => ({
        ts: new Date(e.ts).getTime(),
        label: e.summary,
        kind: e.kind,
      }));
  }, [allEvents]);

  const reconstructedState = useMemo(() => {
    const seen = new Set<string>();
    const result: ChangeEventDoc[] = [];
    for (const row of stateAt) {
      const key = row.uid || `${row.namespace}/${row.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          ...row,
          kind: row.kind,
          name: row.name,
          namespace: row.namespace,
          changeType: row.changeType,
          summary: row.summary,
        });
      }
    }
    return result;
  }, [stateAt]);

  const columns: DataColumn<ChangeEventDoc>[] = [
    { key: 'kind', header: 'Kind', value: (row) => row.kind, width: 100 },
    { key: 'namespace', header: 'Namespace', value: (row) => row.namespace || '(cluster-scoped)' },
    { key: 'name', header: 'Name', value: (row) => row.name },
    { key: 'changeType', header: 'Change Type', value: (row) => row.changeType },
    { key: 'summary', header: 'Summary', value: (row) => row.summary },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <TimelineScrubber
        rangeStart={dayAgo}
        rangeEnd={now}
        ticks={ticks}
        markers={markers}
        value={currentTime}
        onChange={setCurrentTime}
        onCommit={handleScrubberCommit}
        live={currentTime === now}
        onToggleLive={(live) => setCurrentTime(live ? now : currentTime)}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
        <h3 style={{ margin: '0 0 1rem 0' }}>Cluster State at {new Date(currentTime).toLocaleString()}</h3>

        {reconstructedState.length === 0 ? (
          <div className="notice">No workload state recorded at this time.</div>
        ) : (
          <DataTable
            rowKey={(row) => row.uid || row.name}
            columns={columns}
            rows={reconstructedState}
            initialSortKey="name"
            onShowDetails={(row) => setShowDetailsFor(row)}
          />
        )}
      </div>

      {showDetailsFor && (
        <Modal
          title={`${showDetailsFor.kind} ${showDetailsFor.name}`}
          onClose={() => setShowDetailsFor(null)}
        >
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <strong>Namespace:</strong> {showDetailsFor.namespace || '(cluster-scoped)'}
            </div>
            <div>
              <strong>UID:</strong> <code>{showDetailsFor.uid}</code>
            </div>
            <div>
              <strong>Change Type:</strong> {showDetailsFor.changeType}
            </div>
            <div>
              <strong>Severity:</strong> <span className={`badge severity-${showDetailsFor.severity}`}>{showDetailsFor.severity}</span>
            </div>
            <div>
              <strong>Summary:</strong> {showDetailsFor.summary}
            </div>
            {showDetailsFor.reason && (
              <div>
                <strong>Reason:</strong> {showDetailsFor.reason}
              </div>
            )}
            {showDetailsFor.before && (
              <div>
                <strong>Before:</strong>
                <pre style={{ backgroundColor: 'var(--surface-secondary)', padding: '0.5rem', borderRadius: '0.25rem', overflow: 'auto' }}>
                  {JSON.stringify(showDetailsFor.before, null, 2)}
                </pre>
              </div>
            )}
            {showDetailsFor.after && (
              <div>
                <strong>After:</strong>
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
