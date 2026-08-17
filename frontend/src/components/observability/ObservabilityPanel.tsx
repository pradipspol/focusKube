import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Scope } from '../../api/client';
import type { ToastMessage } from '../ToastViewport';
import { TimelinePanel } from './TimelinePanel';
import { MultiPodLogsPanel } from './MultiPodLogsPanel';
import { CorrelationDashboard } from './CorrelationDashboard';
import { useObservabilityWs } from '../../lib/useObservabilityWs';

interface Props {
  scope: Scope;
  namespaces: string[];
  selectedNamespaces: string[];
  onToast: (tone: ToastMessage['tone'], message: string, durationMs?: number) => void;
}

export function ObservabilityPanel({ scope, namespaces, selectedNamespaces, onToast }: Props) {
  const [activeTab, setActiveTab] = useState<'timeline' | 'logs' | 'correlation'>('timeline');
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [wsStatus, setWsStatus] = useState<any>(null);

  const { subscribe } = useObservabilityWs(scope.context ?? undefined);

  // Load initial status
  const { data: httpStatus, isLoading } = useQuery({
    queryKey: ['observability', 'status', scope.context],
    queryFn: () => api.observabilityStatus(scope),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Subscribe to WebSocket status updates (start/stop/resume events)
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === 'status') {
        setWsStatus(message.data);
      }
    });
    return unsubscribe;
  }, [subscribe]);

  // Merge WebSocket updates with HTTP status, preserving available flag
  const status = useMemo(() => {
    const base = httpStatus || { available: false, recording: [] };
    if (!wsStatus) return base;
    // If wsStatus has available field, use it; otherwise merge recording data
    if (wsStatus.available !== undefined) return wsStatus;
    // If wsStatus is just a recording update, merge it with base
    return {
      available: base.available,
      recording: wsStatus.recording !== undefined ? wsStatus.recording : wsStatus,
    };
  }, [httpStatus, wsStatus]);

  const handleStartRecording = async () => {
    setIsStarting(true);
    try {
      const result = await api.observabilityStartRecording(scope);
      // Update UI immediately with the response (optimistic update)
      setWsStatus({
        available: true,
        recording: {
          status: 'active',
          recordingId: result.recordingId
        }
      });
      onToast('success', 'Recording started', 3000);
    } catch (err) {
      onToast('error', `Failed to start recording: ${err instanceof Error ? err.message : String(err)}`, 5000);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopRecording = async () => {
    setIsStopping(true);
    try {
      await api.observabilityStopRecording(scope);
      // Update UI immediately (optimistic update)
      setWsStatus({
        available: true,
        recording: {
          status: 'stopped'
        }
      });
      onToast('success', 'Recording stopped', 3000);
    } catch (err) {
      onToast('error', `Failed to stop recording: ${err instanceof Error ? err.message : String(err)}`, 5000);
    } finally {
      setIsStopping(false);
    }
  };

  const isAvailable = useMemo(() => status?.available ?? false, [status]);
  const isRecording = useMemo(() => status?.recording?.status === 'active', [status]);
  const recordingError = useMemo(() => status?.recording?.errorMessage, [status]);

  if (!scope.context) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="notice">Please select a Kubernetes context from the sidebar to use observability features.</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="notice">Loading...</div>
      </div>
    );
  }

  if (!isAvailable) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '2rem' }}>
        <div className="notice error">
          <strong>Observability Unavailable</strong>
          <p style={{ marginTop: '0.5rem' }}>
            Something went wrong loading the observability store. Try reloading, or check the backend logs for details.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="toolbar" style={{ borderBottom: '1px solid var(--surface-border)', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: '0 0 0.25rem 0' }}>Observability & Time-Travel Debugging</h2>
          <p style={{ margin: '0', fontSize: '0.9em', color: 'var(--text-secondary)' }}>
            Record and replay cluster state changes over time.
          </p>
        </div>

        {/* Recording controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {isRecording ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: '#d32f2f',
                    animation: 'pulse 1.5s infinite',
                  }}
                />
                <span style={{ fontSize: '0.9em', fontWeight: 500 }}>Recording</span>
              </div>
              <button onClick={handleStopRecording} disabled={isStopping} className="action-button">
                {isStopping ? 'Stopping...' : 'Stop Recording'}
              </button>
            </>
          ) : recordingError ? (
            <>
              <div style={{ fontSize: '0.9em', color: '#d32f2f' }}>
                <strong>Error:</strong> {recordingError}
              </div>
              <button onClick={handleStartRecording} disabled={isStarting} className="action-button">
                {isStarting ? 'Starting...' : 'Retry'}
              </button>
            </>
          ) : (
            <button onClick={handleStartRecording} disabled={isStarting} className="action-button">
              {isStarting ? 'Starting...' : 'Start Recording'}
            </button>
          )}
        </div>
      </div>

      {/* Tab navigation */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--surface-border)', backgroundColor: 'var(--surface-secondary)' }}>
        {(['timeline', 'logs', 'correlation'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 0,
              padding: '0.75rem 1.5rem',
              backgroundColor: activeTab === tab ? 'var(--surface)' : 'transparent',
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : 'none',
              cursor: 'pointer',
              fontSize: '0.95em',
              fontWeight: activeTab === tab ? 600 : 400,
              color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none',
              textTransform: 'capitalize',
            }}
          >
            {tab === 'timeline' && '◷ Timeline'}
            {tab === 'logs' && '📋 Multi-Pod Logs'}
            {tab === 'correlation' && '🔗 Event Correlation'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {!isRecording && activeTab !== 'logs' && (
          <div style={{ padding: '1rem', backgroundColor: 'var(--surface-secondary)' }}>
            <div className="notice warning">
              <strong>Recording not active:</strong> Click "Start Recording" above to begin capturing cluster state changes. Without an active recording, the{' '}
              {activeTab === 'timeline' ? 'timeline scrubber' : 'correlation dashboard'} will show no data.
            </div>
          </div>
        )}

        {activeTab === 'timeline' && <TimelinePanel scope={scope} />}
        {activeTab === 'logs' && <MultiPodLogsPanel scope={scope} namespaces={namespaces} selectedNamespaces={selectedNamespaces} />}
        {activeTab === 'correlation' && <CorrelationDashboard scope={scope} />}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .row-warning {
          background-color: rgba(245, 127, 23, 0.1);
        }
        .row-error {
          background-color: rgba(211, 47, 47, 0.1);
        }
        .row-info {
          background-color: rgba(25, 118, 210, 0.05);
        }
        .badge.severity-error {
          background-color: #d32f2f;
          color: white;
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        .badge.severity-warning {
          background-color: #f57c00;
          color: white;
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        .badge.severity-info {
          background-color: #1976d2;
          color: white;
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
      `}</style>
    </div>
  );
}
