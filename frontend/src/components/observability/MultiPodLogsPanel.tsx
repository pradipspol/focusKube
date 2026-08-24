import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Scope } from '../../api/client';
import { wsUrl } from '../../api/client';
import type { MergedLogLine } from '../../lib/logMerge';
import { parseLogLine, boundedMerge } from '../../lib/logMerge';
import { uiText } from '../../text';

interface Props {
  scope: Scope;
  namespaces: string[];
  selectedNamespaces: string[];
}

interface PodOption {
  namespace: string;
  podName: string;
  containers: string[];
}

export function MultiPodLogsPanel({ scope, namespaces, selectedNamespaces }: Props) {
  const [podSelection, setPodSelection] = useState<Array<{ pod: string; namespace: string; container: string }>>([]);
  const [logLines, setLogLines] = useState<MergedLogLine[]>([]);
  const [searchText, setSearchText] = useState('');
  const [matchingLineKeys, setMatchingLineKeys] = useState<Set<string>>(new Set());
  const wsConnectionsRef = useRef<Map<string, WebSocket>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch available pods for selection
  const effectiveNamespaces = selectedNamespaces.length > 0 ? selectedNamespaces : namespaces;

  // Simplified: in a real app, fetch pod list from API per namespace
  // For now, show a simple message to select pods
  const podListItems = useMemo(() => {
    const items: PodOption[] = [];
    // Placeholder: would be populated by fetching pod list via API
    return items;
  }, [effectiveNamespaces]);

  // Search/filter highlighted lines
  useEffect(() => {
    if (!searchText.trim()) {
      setMatchingLineKeys(new Set());
      return;
    }

    const pattern = new RegExp(searchText, 'i');
    const matches = new Set<string>();
    logLines.forEach((line, idx) => {
      if (pattern.test(line.raw)) {
        matches.add(`${idx}`);
      }
    });
    setMatchingLineKeys(matches);
  }, [searchText, logLines]);

  // Open WebSocket connections for each selected pod
  useEffect(() => {
    const openConnections = async () => {
      const currentConnections = new Map(wsConnectionsRef.current);

      for (const selection of podSelection) {
        const connKey = `${selection.namespace}/${selection.pod}/${selection.container}`;
        if (currentConnections.has(connKey)) continue;

        try {
          const url = wsUrl('/ws/logs', {
            context: scope.context,
            namespace: selection.namespace,
            pod: selection.pod,
            container: selection.container,
            follow: 'true',
            tailLines: '100',
            timestamps: 'true',
          });

          const ws = new WebSocket(url);
          ws.addEventListener('message', (event) => {
            const line = event.data.toString().trim();
            if (line.startsWith('error:')) {
              console.error('Log error:', line);
              return;
            }

            const sourceColor = ['var(--danger)', 'var(--accent)', 'var(--info-soft)', 'var(--warn)', 'var(--brand)', 'var(--accent-bright)'][
              [...podSelection].findIndex((s) => s.pod === selection.pod) % 6
            ];

            setLogLines((prev) => {
              const newLines = parseLogLine(line, { podName: selection.pod, containerName: selection.container }, true);
              if (!newLines) return prev;

              const updated = [...prev, { ...newLines, podName: selection.pod, containerName: selection.container }];
              return boundedMerge(updated, 5000);
            });
          });

          ws.addEventListener('error', () => {
            console.error('WebSocket error for', connKey);
            currentConnections.delete(connKey);
          });

          ws.addEventListener('close', () => {
            currentConnections.delete(connKey);
          });

          currentConnections.set(connKey, ws);
        } catch (err) {
          console.error('Failed to open log WS:', err);
        }
      }

      wsConnectionsRef.current = currentConnections;
    };

    openConnections();

    return () => {
      for (const ws of wsConnectionsRef.current.values()) {
        ws.close();
      }
    };
  }, [podSelection, scope.context]);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logLines]);

  const filteredLines = useMemo(() => {
    if (!searchText.trim()) return logLines;
    const pattern = new RegExp(searchText, 'i');
    return logLines.filter((line) => pattern.test(line.raw));
  }, [logLines, searchText]);

  const podColors: Record<string, string> = {
    // Assign consistent colors per pod
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Pod selector toolbar */}
      <div className="toolbar" style={{ borderBottom: '1px solid var(--surface-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <label>
            <strong>{uiText.multiPodLogs.pods}</strong>
            <textarea
              placeholder={uiText.multiPodLogs.podNamesPlaceholder}
              style={{
                display: 'block',
                marginTop: '0.5rem',
                padding: '0.5rem',
                fontFamily: 'monospace',
                width: '100%',
                height: '2.5rem',
                fontSize: '0.85em',
              }}
              value={podSelection.map((s) => s.pod).join(', ')}
              onChange={(e) => {
                const podNames = e.currentTarget.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                setPodSelection(
                  podNames.map((pod) => ({
                    pod,
                    namespace: scope.namespace || namespaces[0] || 'default',
                    container: '',
                  })),
                );
                setLogLines([]);
              }}
            />
          </label>
        </div>

        <input
          type="text"
          placeholder={uiText.multiPodLogs.filterPlaceholder}
          value={searchText}
          onChange={(e) => setSearchText(e.currentTarget.value)}
          style={{ flex: 1, padding: '0.5rem', marginTop: '0.5rem' }}
        />
      </div>

      {/* Logs display */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: 'var(--surface-deepest)',
          color: 'var(--logs-text)',
          fontFamily: 'monospace',
          fontSize: '0.85em',
          padding: '0.5rem',
          lineHeight: 1.4,
        }}
      >
        {podSelection.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            {uiText.multiPodLogs.enterPodsHint}
          </div>
        ) : filteredLines.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{uiText.multiPodLogs.waitingForLogs}</div>
        ) : (
          filteredLines.map((line, idx) => {
            const isMatch = matchingLineKeys.has(`${idx}`);
            const podColors: Record<string, string> = {};
            podSelection.forEach((s, i) => {
              podColors[s.pod] = ['var(--danger)', 'var(--accent)', 'var(--info-soft)', 'var(--warn)', 'var(--brand)', 'var(--accent-bright)'][i % 6];
            });

            return (
              <div
                key={idx}
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: isMatch ? 'var(--highlight-soft)' : undefined,
                  borderLeft: `3px solid ${podColors[line.podName] || 'var(--state-off)'}`,
                  marginBottom: '0.25rem',
                }}
              >
                <span style={{ color: podColors[line.podName] || 'var(--icon-muted)', fontWeight: 'bold' }}>
                  {line.podName}
                </span>{' '}
                <span style={{ color: 'var(--text-dim)' }}>
                  {line.ts.toLocaleTimeString()}
                </span>{' '}
                <span>{line.raw}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Status bar */}
      <div
        style={{
          borderTop: '1px solid var(--surface-border)',
          padding: '0.5rem 1rem',
          fontSize: '0.85em',
          color: 'var(--text-secondary)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>
          {podSelection.length} pod{podSelection.length !== 1 ? 's' : ''} • {logLines.length} line{logLines.length !== 1 ? 's' : ''}
          {searchText && ` • ${matchingLineKeys.size} match${matchingLineKeys.size !== 1 ? 'es' : ''}`}
        </span>
      </div>
    </div>
  );
}
