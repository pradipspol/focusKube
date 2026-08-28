import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Scope } from '../../api/client';
import type { ToastMessage } from '../ToastViewport';
import { TimelinePanel } from './TimelinePanel';
import { MultiPodLogsPanel } from './MultiPodLogsPanel';
import { CorrelationDashboard } from './CorrelationDashboard';
import { useObservabilityWs } from '../../lib/useObservabilityWs';
import { uiText } from '../../text';

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
  const queryClient = useQueryClient();

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
      await queryClient.invalidateQueries({ queryKey: ['observability', 'events', scope.context] });
      await queryClient.invalidateQueries({ queryKey: ['observability', 'correlation', scope.context] });
      onToast('success', 'Recording started');
    } catch (err) {
      onToast('error', `Failed to start recording: ${err instanceof Error ? err.message : String(err)}`);
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
      onToast('success', 'Recording stopped');
    } catch (err) {
      onToast('error', `Failed to stop recording: ${err instanceof Error ? err.message : String(err)}`);
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
        <div className="notice">{uiText.observabilityPanel.selectContext}</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="notice">{uiText.observabilityPanel.loading}</div>
      </div>
    );
  }

  if (!isAvailable) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '2rem' }}>
        <div className="notice error">
          <strong>{uiText.observabilityPanel.unavailableTitle}</strong>
          <p style={{ marginTop: '0.5rem' }}>
            {uiText.observabilityPanel.unavailableDescription}
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
          <h2 style={{ margin: '0 0 0.25rem 0' }}>{uiText.observabilityPanel.title}</h2>
          <p style={{ margin: '0', fontSize: '0.9em', color: 'var(--text-secondary)' }}>
            {uiText.observabilityPanel.subtitle}
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
                    backgroundColor: 'var(--severity-error)',
                    animation: 'pulse 1.5s infinite',
                  }}
                />
                <span style={{ fontSize: '0.9em', fontWeight: 500 }}>{uiText.observabilityPanel.recording}</span>
              </div>
              <button onClick={handleStopRecording} disabled={isStopping} className="action-button">
                {isStopping ? uiText.observabilityPanel.starting : uiText.observabilityPanel.stopRecording}
              </button>
            </>
          ) : recordingError ? (
            <>
              <div style={{ fontSize: '0.9em', color: 'var(--severity-error)' }}>
                <strong>Error:</strong> {recordingError}
              </div>
              <button onClick={handleStartRecording} disabled={isStarting} className="action-button">
                {isStarting ? uiText.observabilityPanel.starting : uiText.observabilityPanel.retry}
              </button>
            </>
          ) : (
            <button onClick={handleStartRecording} disabled={isStarting} className="action-button">
              {isStarting ? uiText.observabilityPanel.starting : uiText.observabilityPanel.startRecording}
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
              borderTop: 'none',
              borderRight: 'none',
              borderLeft: 'none',
              textTransform: 'capitalize',
            }}
          >
            {tab === 'timeline' && uiText.observabilityPanel.timelineTab}
            {tab === 'logs' && uiText.observabilityPanel.logsTab}
            {tab === 'correlation' && uiText.observabilityPanel.correlationTab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {!isRecording && activeTab !== 'logs' && (
          <div style={{ padding: '1rem', backgroundColor: 'var(--surface-secondary)' }}>
            <div className="notice warning">
              <strong>{uiText.observabilityPanel.recordingNotActivePrefix}</strong> {uiText.observabilityPanel.startRecordingHint}{' '}
              {activeTab === 'timeline' ? uiText.observabilityPanel.timelineScrubber : uiText.observabilityPanel.correlationDashboard} {uiText.observabilityPanel.willShowNoData}
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
          background-color: color-mix(in srgb, var(--severity-warning) 10%, transparent);
        }
        .row-error {
          background-color: color-mix(in srgb, var(--severity-error) 10%, transparent);
        }
        .row-info {
          background-color: color-mix(in srgb, var(--severity-info) 5%, transparent);
        }
        .badge.severity-error {
          background-color: var(--severity-error);
          color: var(--text-on-accent);
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        .badge.severity-warning {
          background-color: var(--severity-warning);
          color: var(--text-on-accent);
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        .badge.severity-info {
          background-color: var(--severity-info);
          color: var(--text-on-accent);
          padding: 0.25rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
      `}</style>
    </div>
  );
}
