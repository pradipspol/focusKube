import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, wsUrl, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { uiText } from '../text';
import { LoadingOverlay } from './LoadingOverlay';

interface Props {
  scope: Scope;
  authRecoveryRefreshToken?: number;
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
}

type TargetKind = 'pods' | 'services';

type ForwardStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

type ForwardMessage =
  | { type: 'STARTING'; namespace?: string; targetKind: string; targetName: string; targetPort: string; localPort?: string }
  | { type: 'READY'; localPort: number; target: string }
  | { type: 'OUTPUT'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'STOPPED'; code: number }
  | { type: 'ERROR'; message: string };

export function PortForwardingPanel({ scope, authRecoveryRefreshToken, onAzureAuthRequired }: Props) {
  const [targetKind, setTargetKind] = useState<TargetKind>('pods');
  const [targetKey, setTargetKey] = useState('');
  const [targetPort, setTargetPort] = useState('');
  const [localPort, setLocalPort] = useState('');
  const [status, setStatus] = useState<ForwardStatus>('idle');
  const [statusText, setStatusText] = useState<string>(uiText.portForwarding.selectTargetStart);
  const [forwardedPort, setForwardedPort] = useState<string | undefined>();
  const [output, setOutput] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  const podQuery = useQuery({
    queryKey: ['port-forward', 'pods', scope.context, scope.namespace],
    queryFn: async () => api.listResource('pods', scope),
    enabled: !!scope.context,
  });

  useAzureAuthRequiredEffect(podQuery.error, onAzureAuthRequired);

  const serviceQuery = useQuery({
    queryKey: ['port-forward', 'services', scope.context, scope.namespace],
    queryFn: async () => api.listResource('services', scope),
    enabled: !!scope.context,
  });

  useAzureAuthRequiredEffect(serviceQuery.error, onAzureAuthRequired);

  const lastAuthRecoveryTokenRef = useRef<number>(0);
  useEffect(() => {
    if (!authRecoveryRefreshToken || !scope.context) return;
    if (lastAuthRecoveryTokenRef.current === authRecoveryRefreshToken) return;
    lastAuthRecoveryTokenRef.current = authRecoveryRefreshToken;
    void podQuery.refetch();
    void serviceQuery.refetch();
  }, [authRecoveryRefreshToken, scope.context, podQuery.refetch, serviceQuery.refetch]);

  const targets = useMemo(() => {
    const items = targetKind === 'pods' ? podQuery.data?.items ?? [] : serviceQuery.data?.items ?? [];
    return items
      .map((item) => {
        const name = item.metadata?.name ?? '';
        const namespace = item.metadata?.namespace ?? scope.namespace ?? '';
        return { item, name, namespace, key: `${namespace}/${name}` };
      })
      .filter((entry) => entry.name.length > 0);
  }, [podQuery.data?.items, scope.namespace, serviceQuery.data?.items, targetKind]);

  const selectedTarget = useMemo(
    () => targets.find((entry) => entry.key === targetKey) ?? targets[0],
    [targetKey, targets],
  );

  const targetPorts = useMemo(() => extractTargetPorts(selectedTarget?.item, targetKind), [selectedTarget?.item, targetKind]);

  useEffect(() => {
    if (targets.length === 0) {
      setTargetKey('');
      return;
    }
    if (!targets.some((entry) => entry.key === targetKey)) {
      setTargetKey(targets[0].key);
    }
  }, [targetKey, targets]);

  useEffect(() => {
    if (targetPorts.length === 0) return;
    if (!targetPorts.some((entry) => entry.value === targetPort)) {
      setTargetPort(targetPorts[0].value);
    }
  }, [targetPort, targetPorts]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const stopForwarding = () => {
    socketRef.current?.close();
    socketRef.current = null;
    setStatus('stopped');
    setStatusText(uiText.portForwarding.stopped);
  };

  const startForwarding = () => {
    if (!scope.context) {
      setStatus('error');
      setStatusText(uiText.portForwarding.selectContextBeforeStart);
      return;
    }
    if (!selectedTarget || !targetPort.trim()) {
      setStatus('error');
      setStatusText(uiText.portForwarding.pickTargetPort);
      return;
    }

    socketRef.current?.close();
    setOutput([]);
    setForwardedPort(undefined);
    setStatus('starting');
    setStatusText(uiText.portForwarding.startingPrefix(targetKind));

    const socket = new WebSocket(wsUrl('/ws/port-forward', { context: scope.context }));
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          namespace: selectedTarget.namespace || scope.namespace || undefined,
          targetKind: targetKind === 'pods' ? 'pod' : 'service',
          targetName: selectedTarget.name,
          targetPort: targetPort.trim(),
          localPort: localPort.trim() || undefined,
        }),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: ForwardMessage | undefined;
      try {
        message = JSON.parse(event.data) as ForwardMessage;
      } catch {
        setOutput((current) => [...current, event.data]);
        return;
      }

      if (message.type === 'STARTING') {
        setStatus('starting');
        setStatusText(uiText.portForwarding.forwardingPrefix(message.targetKind, message.targetName));
        return;
      }

      if (message.type === 'READY') {
        setStatus('running');
        setForwardedPort(String(message.localPort));
        setStatusText(uiText.portForwarding.forwardingOnLoopback(message.localPort));
        return;
      }

      if (message.type === 'OUTPUT') {
        setOutput((current) => [...current, message.text]);
        return;
      }

      if (message.type === 'STOPPED') {
        setStatus('stopped');
        setStatusText(uiText.portForwarding.portForwardProcessExitedPrefix(message.code));
        socketRef.current = null;
        return;
      }

      if (message.type === 'ERROR') {
        setStatus('error');
        setStatusText(message.message);
      }
    };

    socket.onclose = () => {
      socketRef.current = null;
      setStatus((current) => (current === 'running' ? 'stopped' : current));
    };

    socket.onerror = () => {
      setStatus('error');
      setStatusText(uiText.portForwarding.socketFailed);
    };
  };

  const targetName = selectedTarget?.name ?? '';
  const openAddress = forwardedPort ? `http://127.0.0.1:${forwardedPort}` : localPort.trim() ? `http://127.0.0.1:${localPort.trim()}` : '';

  return (
    <div className="empty">
      {!!scope.context && (podQuery.isLoading || serviceQuery.isLoading) && (
        <LoadingOverlay message={uiText.portForwarding.refreshingTargets} />
      )}
      <h2>{uiText.portForwarding.title}</h2>
      <p>{uiText.portForwarding.description}</p>
      <div className="actions-bar" style={{ flexWrap: 'wrap', gap: '12px' }}>
        <div className="field">
          <label>{uiText.portForwarding.target}</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className={`nav-item ${targetKind === 'pods' ? 'active' : ''}`} type="button" onClick={() => setTargetKind('pods')} disabled={status === 'starting' || status === 'running'}>
              {uiText.portForwarding.podLabel}
            </button>
            <button className={`nav-item ${targetKind === 'services' ? 'active' : ''}`} type="button" onClick={() => setTargetKind('services')} disabled={status === 'starting' || status === 'running'}>
              {uiText.portForwarding.serviceLabel}
            </button>
          </div>
        </div>

        <div className="field">
          <label>{uiText.portForwarding.resource}</label>
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} disabled={status === 'starting' || status === 'running' || targets.length === 0}>
            {targets.length === 0 ? (
              <option value="">{uiText.portForwarding.noResourcesFound(targetKind)}</option>
            ) : (
              targets.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.namespace ? `${entry.namespace}/` : ''}{entry.name}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="field">
          <label>{uiText.portForwarding.targetPort}</label>
          <input
            list="port-forward-target-ports"
            value={targetPort}
            onChange={(e) => setTargetPort(e.target.value)}
            placeholder={targetPorts[0]?.value ?? '8080'}
            disabled={status === 'starting' || status === 'running'}
          />
          <datalist id="port-forward-target-ports">
            {targetPorts.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </datalist>
        </div>

        <div className="field">
          <label>{uiText.portForwarding.localPort}</label>
          <input
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={targetPort || 'same as target'}
            disabled={status === 'starting' || status === 'running'}
          />
        </div>

        <div className="field" style={{ minWidth: '220px' }}>
          <label>{uiText.portForwarding.status}</label>
          <div className={`badge ${status === 'running' ? 'ok' : status === 'error' ? 'warn' : ''}`}>{status}</div>
        </div>
      </div>

      <div className="actions-bar" style={{ marginTop: '8px' }}>
        {status !== 'running' ? (
          <button className="nav-item" type="button" onClick={startForwarding} disabled={!scope.context || targets.length === 0}>
            {uiText.portForwarding.startPortForward}
          </button>
        ) : (
          <button className="nav-item danger" type="button" onClick={stopForwarding}>
            {uiText.portForwarding.stopPortForward}
          </button>
        )}
        {openAddress && status === 'running' && (
          <a className="nav-item" href={openAddress} target="_blank" rel="noreferrer">
            {uiText.portForwarding.open} {openAddress}
          </a>
        )}
        {(podQuery.isFetching || serviceQuery.isFetching) && (
          <span className="tiny-spinner" aria-label={uiText.portForwarding.refreshingTargets} />
        )}
      </div>

      <div className="sidebar-hint" style={{ marginTop: '8px' }}>{statusText}</div>
      {!scope.context && <div className="sidebar-hint">{uiText.portForwarding.selectContext}</div>}
      {targetKind === 'pods' && selectedTarget?.item && selectedTarget.item.spec?.containers?.length > 0 && (
        <div className="sidebar-hint">
          Pod containers: {selectedTarget.item.spec.containers.map((container: any) => container.name).join(', ')}
        </div>
      )}
      {output.length > 0 && (
        <div className="terminal-host" style={{ marginTop: '12px', minHeight: '160px', whiteSpace: 'pre-wrap' }}>
          {output.map((line, index) => (
            <div key={`${index}-${line}`}>{line}</div>
          ))}
        </div>
      )}
      {status === 'running' && targetName && (
        <div className="sidebar-hint">Forwarding {targetKind.slice(0, -1)} {targetName}.</div>
      )}
    </div>
  );
}

function extractTargetPorts(target: K8sObject | undefined, kind: TargetKind): Array<{ label: string; value: string }> {
  if (!target) return [];

  const ports: Array<{ label: string; value: string }> = [];
  if (kind === 'pods') {
    const containers = Array.isArray(target.spec?.containers) ? target.spec.containers : [];
    for (const container of containers) {
      const containerPorts = Array.isArray(container.ports) ? container.ports : [];
      for (const port of containerPorts) {
        const value = String(port.containerPort ?? '');
        if (!value) continue;
        ports.push({
          value,
          label: `${container.name}${port.name ? ` / ${port.name}` : ''}: ${value}/${port.protocol ?? 'TCP'}`,
        });
      }
    }
  } else {
    const servicePorts = Array.isArray(target.spec?.ports) ? target.spec.ports : [];
    for (const port of servicePorts) {
      const numericPort = typeof port.port === 'number' ? port.port : undefined;
      const value = numericPort ? String(numericPort) : typeof port.targetPort === 'number' ? String(port.targetPort) : '';
      if (!value) continue;
      const targetPort = typeof port.targetPort === 'string' || typeof port.targetPort === 'number' ? ` -> ${port.targetPort}` : '';
      ports.push({
        value,
        label: `${port.name ? `${port.name}: ` : ''}${value}${targetPort}/${port.protocol ?? 'TCP'}`,
      });
    }
  }

  const deduped = new Map<string, { label: string; value: string }>();
  for (const entry of ports) {
    if (!deduped.has(entry.value)) deduped.set(entry.value, entry);
  }
  return Array.from(deduped.values());
}