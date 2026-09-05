import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, wsUrl, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { podContainers } from '../utils/format';
import { uiText } from '../text';
import { boundedMerge, mergeLogStreams, type MergedLogLine } from '../lib/logMerge';

type PodLogsProps = {
  kind: 'pod';
  pod: K8sObject;
  context?: string;
  initialFollow?: boolean;
  onOpenInTerminal?: () => void;
};

type DeploymentLogsProps = {
  kind: 'deployment';
  deployment: K8sObject;
  context?: string;
  initialFollow?: boolean;
  onOpenInTerminal?: () => void;
};

export type LogsPanelProps = PodLogsProps | DeploymentLogsProps;

function closeSocket(socket: WebSocket | null): void {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  socket.close();
}

function splitLogChunk(chunk: string): string[] {
  return chunk.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

export function LogsPanel(props: LogsPanelProps) {
  const [follow, setFollow] = useState(props.initialFollow ?? true);
  const [connected, setConnected] = useState(false);
  const [container, setContainer] = useState('');
  const [lines, setLines] = useState<MergedLogLine[]>([]);
  const [searchText, setSearchText] = useState('');
  const [hasReceivedLogs, setHasReceivedLogs] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const kind = props.kind;
  const context = props.context;
  const pod = kind === 'pod' ? props.pod : undefined;
  const deployment = kind === 'deployment' ? props.deployment : undefined;

  const deploymentPodsQuery = useQuery({
    queryKey: kind === 'deployment'
      ? ['deployment-logs-pods', deployment?.metadata?.namespace, deployment?.metadata?.name, context]
      : ['pod-logs-noop', pod?.metadata?.namespace, pod?.metadata?.name, context],
    enabled: kind === 'deployment' && !!deployment?.metadata?.namespace,
    refetchInterval: kind === 'deployment' ? 15_000 : false,
    queryFn: async () => {
      if (!deployment) return [] as K8sObject[];
      const selector = deployment.spec?.selector?.matchLabels ?? {};
      const scope: Scope = { context, namespace: deployment.metadata?.namespace };
      const response = await api.listResource('pods', scope);
      return (response.items ?? []).filter((pod) => {
        const podLabels = pod.metadata?.labels ?? {};
        return Object.entries(selector).every(([key, value]) => podLabels[key] === String(value));
      });
    },
  });

  const deploymentPodsLoaded = kind !== 'deployment' || deploymentPodsQuery.isFetched;

  const deploymentPodNames = kind === 'deployment'
    ? (deploymentPodsQuery.data ?? []).map((pod) => pod.metadata?.name ?? '').filter(Boolean)
    : [];
  const deploymentPodSignature = deploymentPodNames.join('|');
  const podName = kind === 'pod' ? pod?.metadata?.name ?? '' : '';
  const deploymentName = kind === 'deployment' ? deployment?.metadata?.name ?? '' : '';
  const connectionKey = kind === 'pod'
    ? `${context ?? ''}|${podName}|${container}|${follow}`
    : `${context ?? ''}|${deploymentName}|${deploymentPodSignature}|${container}|${follow}`;

  const availableContainers = useMemo(() => {
    if (kind === 'pod' && pod) return podContainers(pod);
    const deploymentContainers = deployment?.spec?.template?.spec?.containers ?? [];
    const fromDeployment = deploymentContainers.map((c: any) => c.name).filter(Boolean);
    if (fromDeployment.length > 0) return fromDeployment;
    const firstPod = deploymentPodsQuery.data?.[0];
    return podContainers(firstPod ?? deployment ?? ({} as K8sObject));
  }, [deployment, deploymentPodsQuery.data, kind, pod]);

  useEffect(() => {
    if (availableContainers.length === 0) {
      setContainer('');
      return;
    }
    setContainer((current) => (current && availableContainers.includes(current) ? current : availableContainers[0]));
  }, [availableContainers]);

  useEffect(() => {
    setLines([]);
    setSearchText('');
    setHasReceivedLogs(false);
  }, [kind, podName, deploymentName]);

  useEffect(() => {
    if (!follow) return;
    const host = hostRef.current;
    if (!host) return;
    host.scrollTop = host.scrollHeight;
  }, [follow, lines]);

  useEffect(() => {
    if (!container) return;

    if (kind === 'pod' && pod) {
      const url = wsUrl('/ws/logs', {
        context,
        namespace: pod.metadata?.namespace,
        pod: pod.metadata?.name,
        container,
        follow: String(follow),
        tailLines: '500',
        timestamps: 'true',
      });
      const ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (event) => {
        const chunk = typeof event.data === 'string' ? event.data : '';
        const rawLines = splitLogChunk(chunk);
        if (rawLines.length === 0) return;
        setHasReceivedLogs(true);
        const podName = pod.metadata?.name ?? 'pod';
        setLines((current) => boundedMerge(
          mergeLogStreams(current, rawLines.map((raw) => ({ raw, source: { podName, containerName: container }, includeTimestamp: true }))),
        ));
      };
      return () => closeSocket(ws);
    }

    if (kind === 'deployment' && deployment) {
      const url = wsUrl('/ws/logs', {
        context,
        namespace: deployment.metadata?.namespace,
        deployment: deployment.metadata?.name,
        container,
        follow: String(follow),
        tailLines: '500',
        timestamps: 'true',
      });
      const ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (event) => {
        const chunk = typeof event.data === 'string' ? event.data : '';
        const rawLines = splitLogChunk(chunk);
        if (rawLines.length === 0) return;
        setHasReceivedLogs(true);
        setLines((current) => boundedMerge(
          mergeLogStreams(current, rawLines.map((raw) => ({ raw, source: { podName: deploymentName || 'deployment', containerName: container }, includeTimestamp: true }))),
        ));
      };
      return () => closeSocket(ws);
    }
  }, [connectionKey, container, context, deployment, deploymentName, follow, kind, pod, podName]);

  const filteredLines = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return lines;
    return lines.filter((line) => `${line.podName} ${line.containerName} ${line.raw}`.toLowerCase().includes(query));
  }, [lines, searchText]);

  const title = kind === 'pod' ? uiText.logs.container : uiText.resourceDetail.logs;

  return (
    <div className="drawer-body">
      <div className="actions-bar">
        {kind === 'pod' && pod ? (
          <div className="field">
            <label>{title}</label>
            <select value={container} onChange={(event) => setContainer(event.target.value)}>
              {availableContainers.map((c: string) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field" style={{ minWidth: 180 }}>
            <label>{title}</label>
            <div className="dim">Combined logs from {deploymentPodNames.length} pod{deploymentPodNames.length === 1 ? '' : 's'}</div>
          </div>
        )}
        <label className="field">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          {uiText.logs.follow}
        </label>
        {(
          <button className="drawer-action-icon" type="button" title={uiText.logs.openInTerminal} onClick={props.onOpenInTerminal}>
            ⤴
          </button>
        )}
        <input
          className="field"
          style={{ minWidth: 320}}
          type="search"
          placeholder={uiText.resourceDetail.logs}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <span className={`badge ${connected ? 'ok' : 'warn'} right`}>
          {connected ? uiText.logs.streaming : uiText.logs.disconnected}
        </span>
      </div>
      <div className="logs-host" ref={hostRef}>
        {!hasReceivedLogs ? (
          <div className="dim" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tiny-spinner" aria-label="Loading logs" />
            <span>{kind === 'deployment' && !deploymentPodsLoaded ? 'Loading deployment pods...' : uiText.common.loading}</span>
          </div>
        ) : filteredLines.length === 0 ? (
          <div className="dim" style={{ padding: 12 }}>
            {kind === 'deployment'
              ? (!deploymentPodsLoaded ? 'Loading deployment pods...' : connected ? 'Waiting for logs...' : 'No logs available.')
              : 'Waiting for logs...'}
          </div>
        ) : (
          filteredLines.map((line, index) => (
            <div key={`${line.sourceId}-${index}`} style={{ whiteSpace: 'pre-wrap' }}>
              {/* {kind === 'deployment' && <span className="dim">{line.podName}</span>}{' '}
              {kind === 'deployment' && <span className="dim">{line.containerName}</span>}{' '} */}
              <span>{line.raw}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}