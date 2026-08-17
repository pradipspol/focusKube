import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api/client';
import type { K8sObject } from '../api/types';
import { podContainers } from '../utils/format';

interface Props {
  pod: K8sObject;
  context?: string;
  initialFollow?: boolean;
  onOpenInTerminal?: () => void;
}

export function LogsViewer({ pod, context, initialFollow = true, onOpenInTerminal }: Props) {
  const containers = podContainers(pod);
  const [container, setContainer] = useState(containers[0] ?? '');
  const [follow, setFollow] = useState(initialFollow);
  const [connected, setConnected] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!container) return;
    const host = hostRef.current;
    if (host) host.textContent = '';

    const url = wsUrl('/ws/logs', {
      context,
      namespace: pod.metadata?.namespace,
      pod: pod.metadata?.name,
      container,
      follow: String(follow),
      tailLines: '500',
    });
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      if (!host) return;
      const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
      host.textContent += typeof e.data === 'string' ? e.data : '';
      if (follow && atBottom) host.scrollTop = host.scrollHeight;
    };
    return () => ws.close();
  }, [container, follow, context, pod]);

  return (
    <div className="drawer-body">
      <div className="actions-bar">
        <div className="field">
          <label>Container</label>
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <label className="field">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        {onOpenInTerminal && (
          <button className="drawer-action-icon" type="button" title="Open in terminal tab" onClick={onOpenInTerminal}>
            ⤴
          </button>
        )}
        <span className={`badge ${connected ? 'ok' : 'warn'} right`}>
          {connected ? 'streaming' : 'disconnected'}
        </span>
      </div>
      <div className="logs-host" ref={hostRef} />
    </div>
  );
}
