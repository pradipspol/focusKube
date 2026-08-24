import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, getDesktopEmail, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { getMetricsWorker } from '../utils/workerRuntime';
import { LogsViewer } from './LogsViewer';
import { ExecTerminal } from './ExecTerminal';
import { DeploymentActions } from './DeploymentActions';
import type { OpenPodLogsTerminalRequest, OpenPodTerminalRequest } from './TerminalDock';
import { uiText } from '../text';

interface Props {
  plural: string;
  object: K8sObject;
  scope: Scope;
  initialTab?: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenPodTerminal?: (request: OpenPodTerminalRequest) => void;
  onOpenPodLogsTerminal?: (request: OpenPodLogsTerminalRequest) => void;
}

export function ResourceDetail({ plural, object, scope, initialTab, onClose, onChanged, onOpenPodTerminal, onOpenPodLogsTerminal }: Props) {
  const name = object.metadata!.name!;
  const ns = object.metadata?.namespace;
  const opScope: Scope = { ...scope, namespace: ns };
  const { canWrite, canDelete } = usePermissions();
  const needsHydration = plural === 'configmaps' || plural === 'secrets';

  const fullObjectQuery = useQuery({
    queryKey: ['resource-full', plural, name, scope.context, scope.namespace],
    queryFn: () => api.getResource(plural, name, scope),
    enabled: needsHydration,
    staleTime: 10_000,
  });
  const currentObject = fullObjectQuery.data ?? object;

  const del = useMutation({
    mutationFn: () =>
      api.deleteResource(plural, name, {
        ...scope,
        namespace: ns,
      }),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  const restart = useMutation({
    mutationFn: () =>
      api.restartDeployment(name, {
        ...scope,
        namespace: ns,
      }),
    onSuccess: () => onChanged(),
  });

  const tabs = useMemo(() => {
    const t: string[] = ['yaml'];
    if (plural === 'deployments') t.unshift('overview');
    if (plural === 'deployments') t.unshift('actions');
    if (plural === 'pods') t.unshift('overview');
    if (['daemonsets', 'statefulsets', 'replicasets', 'jobs', 'cronjobs'].includes(plural)) t.unshift('overview');
    if (plural === 'configmaps' || plural === 'secrets') t.unshift('details');
    if (plural === 'pods') {
      t.push('logs');
      // Exec opens an interactive shell — a write-capable action.
      if (canWrite) t.push('exec');
    }
    if (plural === 'secrets') t.push('secret');
    return t;
  }, [plural, canWrite]);

  const [tab, setTab] = useState<string>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0]);

  useEffect(() => {
    if (!needsHydration) return;
    if (fullObjectQuery.data) return;
    if (fullObjectQuery.isLoading) return;
  }, [needsHydration, fullObjectQuery.data, fullObjectQuery.isLoading]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <span className="badge">{currentObject.kind ?? plural}</span>
          <h3>{ns ? `${ns} / ${name}` : name}</h3>
          <div className="drawer-header-actions">
            {plural === 'pods' && (
              <>
                <button className="drawer-action-icon" title={uiText.resourceDetail.logs} onClick={() => setTab('logs')}>≣</button>
                {canWrite && (
                  <button className="drawer-action-icon" title={uiText.resourceDetail.shell} onClick={() => setTab('exec')}>{'>_'}</button>
                )}
              </>
            )}
            {plural === 'deployments' && (
              <>
                {canWrite && (
                  <button
                    className="drawer-action-icon"
                    title={uiText.resourceDetail.restartDeployment}
                    onClick={() => restart.mutate()}
                    disabled={restart.isPending}
                  >
                    ↻
                  </button>
                )}
                <button className="drawer-action-icon" title={uiText.resourceDetail.deploymentActions} onClick={() => setTab('actions')}>⋯</button>
              </>
            )}
            {canWrite && (
              <button className="drawer-action-icon" title={uiText.resourceDetail.editYaml} onClick={() => setTab('yaml')}>✎</button>
            )}
            {canDelete && (
              <button
                className="drawer-action-icon danger"
                title={`${uiText.resourceDetail.deletePrefix} ${plural.slice(0, -1) || plural}`}
                onClick={() => {
                  const podWarning = [
                    `${uiText.resourceDetail.warningPrefix} "${name}".`,
                    uiText.resourceDetail.destructiveActionNotice,
                    '',
                    uiText.resourceDetail.continuePrompt,
                  ].join('\n');
                  const genericWarning = `${uiText.resourceDetail.deletePrefix} ${plural} "${name}"?`;
                  if (!confirm(plural === 'pods' ? podWarning : genericWarning)) return;
                  del.mutate();
                }}
                disabled={del.isPending}
              >
                🗑
              </button>
            )}
          </div>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="tabs">
          {tabs.map((t) => (
            <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'yaml' ? uiText.resourceDetail.yaml : t === 'overview' ? uiText.resourceDetail.overview : t.charAt(0).toUpperCase() + t.slice(1)}
            </div>
          ))}
        </div>

        {tab === 'overview' && plural === 'pods' && <PodOverviewTab pod={currentObject} scope={scope} />}
        {tab === 'overview' && plural === 'deployments' && <DeploymentOverviewTab deployment={currentObject} />}
        {tab === 'overview' && ['daemonsets', 'statefulsets', 'replicasets', 'jobs', 'cronjobs'].includes(plural) && (
          <WorkloadOverviewTab resource={currentObject} plural={plural} />
        )}
        {tab === 'details' && (plural === 'configmaps' || plural === 'secrets') && (
          <ConfigLikeDetailsTab
            kind={plural}
            object={currentObject}
            scope={opScope}
            onChanged={onChanged}
          />
        )}
        {tab === 'yaml' && (
          <YamlTab plural={plural} name={name} scope={opScope} onSaved={onChanged} />
        )}
        {tab === 'actions' && plural === 'deployments' && (
          <DeploymentActions deployment={currentObject} scope={scope} onChanged={onChanged} />
        )}
        {tab === 'logs' && (
          <LogsViewer
            pod={currentObject}
            context={scope.context}
            onOpenInTerminal={
              onOpenPodLogsTerminal
                ? () => onOpenPodLogsTerminal({ pod: currentObject, context: scope.context })
                : undefined
            }
          />
        )}
        {tab === 'exec' && <ExecTerminal pod={currentObject} context={scope.context} onOpenInTerminal={onOpenPodTerminal} />}
        {tab === 'secret' && <SecretTab name={name} scope={opScope} />}
      </div>
    </div>
  );
}

function PodOverviewTab({ pod, scope }: { pod: K8sObject; scope: Scope }) {
  const [metricsWindow, setMetricsWindow] = useState<'1h' | '6h' | '24h'>('1h');
  const [cpuHistory, setCpuHistory] = useState<Array<{ at: number; value: number }>>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [metricsData, setMetricsData] = useState<any>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsState, setMetricsState] = useState<'connecting' | 'live' | 'disconnected'>('connecting');
  const metricsWorkerRef = useRef<Worker | null>(null);

  const eventsQuery = useQuery({
    queryKey: ['pod-events', scope.context, pod.metadata?.namespace, pod.metadata?.name],
    queryFn: () =>
      api.listResource('events', {
        ...scope,
        namespace: pod.metadata?.namespace,
      }),
    enabled: !!pod.metadata?.namespace,
  });

  useEffect(() => {
    if (!scope.context || !pod.metadata?.namespace || !pod.metadata?.name) return;

    const worker = getMetricsWorker();
    metricsWorkerRef.current = worker;

    const onMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload) return;
      if (payload.type === 'state') {
        setMetricsState(payload.state);
        return;
      }
      if (payload.type === 'error') {
        setMetricsError(payload.message);
        setMetricsState('disconnected');
        return;
      }
      if (payload.type === 'metrics') {
        setMetricsData(payload.data);
        setMetricsError(null);
      }
    };
    worker.addEventListener('message', onMessage as EventListener);

    const startMsg = {
      type: 'start',
      payload: {
        email: getDesktopEmail(),
        context: scope.context,
        namespace: pod.metadata.namespace,
        pod: pod.metadata.name,
      },
    };
    worker.postMessage(startMsg);

    return () => {
      const current = metricsWorkerRef.current;
      if (!current) return;
      const stopMsg = { type: 'stop' };
      current.postMessage(stopMsg);
      current.removeEventListener('message', onMessage as EventListener);
      metricsWorkerRef.current = null;
    };
  }, [scope.context, pod.metadata?.namespace, pod.metadata?.name]);

  const ownerRefs = Array.isArray((pod.metadata as any)?.ownerReferences)
    ? ((pod.metadata as any).ownerReferences as Array<{ kind?: string; name?: string }>)
    : [];
  const owner = ownerRefs[0];
  const labels = pod.metadata?.labels ?? {};
  const annotations = pod.metadata?.annotations ?? {};
  const conditions = Array.isArray(pod.status?.conditions)
    ? (pod.status.conditions as Array<{ type?: string; status?: string }>).filter((c) => c.status === 'True')
    : [];
  const tolerations = Array.isArray(pod.spec?.tolerations) ? pod.spec.tolerations : [];
  const antiAffinities = pod.spec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution ??
    pod.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  const volumes = Array.isArray(pod.spec?.volumes) ? pod.spec.volumes : [];
  const containers = Array.isArray(pod.spec?.containers) ? pod.spec.containers : [];
  const podIps: string[] = Array.isArray((pod.status as any)?.podIPs)
    ? ((pod.status as any).podIPs as Array<{ ip?: string }>).map((entry) => entry.ip).filter(Boolean) as string[]
    : pod.status?.podIP
      ? [pod.status.podIP]
      : [];
  const relatedEvents = (eventsQuery.data?.items ?? [])
    .filter((event) => ((event as any).involvedObject?.name as string | undefined) === pod.metadata?.name)
    .sort((a, b) => {
      const aTs = new Date((a.lastTimestamp ?? a.eventTime ?? a.metadata?.creationTimestamp ?? '') as string).getTime();
      const bTs = new Date((b.lastTimestamp ?? b.eventTime ?? b.metadata?.creationTimestamp ?? '') as string).getTime();
      return bTs - aTs;
    });
  const metricsContainers = metricsData?.containers ?? [];
  const totalCpuMillicores = metricsContainers.reduce((sum: number, c: any) => sum + c.cpuMillicores, 0);
  const totalMemoryBytes = metricsContainers.reduce((sum: number, c: any) => sum + c.memoryBytes, 0);
  const requestTotals = sumContainerResources(containers, 'requests');
  const limitTotals = sumContainerResources(containers, 'limits');

  useEffect(() => {
    if (!metricsData) return;
    const at = metricsData.timestamp ? new Date(metricsData.timestamp).getTime() : Date.now();
    setCpuHistory((current) => {
      const cutoff = Date.now() - windowMs(metricsWindow);
      const next = [...current.filter((entry) => entry.at >= cutoff), { at, value: totalCpuMillicores }];
      return next.slice(-240);
    });
  }, [metricsData, metricsWindow, totalCpuMillicores]);

  const cpuSeries = useMemo(() => buildMetricPath(cpuHistory, 'usage'), [cpuHistory]);
  const maxCpu = Math.max(totalCpuMillicores, requestTotals.cpuMillicores, limitTotals.cpuMillicores, ...cpuHistory.map((p) => p.value), 1);
  const requestY = 220 - (requestTotals.cpuMillicores / maxCpu) * 180;
  const limitY = 220 - (limitTotals.cpuMillicores / maxCpu) * 180;

  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  const properties: Array<[string, string]> = [
    ['Created', formatCreated(pod.metadata?.creationTimestamp)],
    ['Name', pod.metadata?.name ?? '-'],
    ['Namespace', pod.metadata?.namespace ?? '-'],
    ['Labels', `${Object.keys(labels).length} Labels`],
    ['Controlled', owner?.kind && owner?.name ? `${owner.kind} ${owner.name}` : '-'],
    ['Status', pod.status?.phase ?? '-'],
    ['Node', pod.spec?.nodeName ?? '-'],
    ['Pod IP', pod.status?.podIP ?? '-'],
    ['Pod IPs', podIps.join(', ') || '-'],
    ['Service Account', pod.spec?.serviceAccountName ?? '-'],
    ['QoS Class', pod.status?.qosClass ?? '-'],
    ['Conditions', conditions.map((c) => c.type).join(', ') || '-'],
    ['Tolerations', tolerations.length ? String(tolerations.length) : '-'],
    ['Pod Anti Affinities', antiAffinities.length ? `${antiAffinities.length} Rule${antiAffinities.length > 1 ? 's' : ''}` : '-'],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Metrics</h4>
          <div className="metrics-toolbar">
            <select value={metricsWindow} onChange={(e) => setMetricsWindow(e.target.value as '1h' | '6h' | '24h')}>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
            </select>
          </div>
        </div>
        <div className="metrics-note">Displaying metrics from Kubernetes Metrics Server</div>
        <div className="metrics-chart-placeholder">
          <div className="metrics-grid" />
          <svg className="metrics-svg" viewBox="0 0 720 240" preserveAspectRatio="none">
            <line x1="0" y1={requestY} x2="720" y2={requestY} className="metrics-line request" />
            <line x1="0" y1={limitY} x2="720" y2={limitY} className="metrics-line limit" />
            <path d={cpuSeries} className="metrics-line usage" />
          </svg>
          <div className="metrics-stats">
            <span>CPU: {totalCpuMillicores.toFixed(0)}m</span>
            <span>Memory: {formatBytes(totalMemoryBytes)}</span>
            {metricsData?.timestamp && <span>Updated: {new Date(metricsData.timestamp).toLocaleTimeString()}</span>}
            {metricsState !== 'live' && <span className="metrics-status">{metricsState}</span>}
            {metricsError && <span className="metrics-error">Error: {metricsError}</span>}
          </div>
          <div className="metrics-legend">
            <span><span className="metrics-swatch usage" />CPU Usage</span>
            <span><span className="metrics-swatch request" />CPU Requests</span>
            <span><span className="metrics-swatch limit" />CPU Limits</span>
          </div>
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Properties</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className={`pod-property-value ${label === 'Status' && value === 'Running' ? 'status-running' : ''}`}>
                {value}
              </div>
            </div>
          ))}
          <div className="pod-property-row expandable" onClick={() => toggle('labels')}>
            <div className="pod-property-label">Labels</div>
            <div className="pod-property-value linkish">{Object.keys(labels).length} Labels {expanded.labels ? '▾' : '▸'}</div>
          </div>
          {expanded.labels && (
            <div className="pod-detail-list">
              {Object.entries(labels).map(([key, value]) => <span key={key} className="inline-chip mono">{key}={value}</span>)}
            </div>
          )}
          <div className="pod-property-row expandable" onClick={() => toggle('annotations')}>
            <div className="pod-property-label">Annotations</div>
            <div className="pod-property-value linkish">{Object.keys(annotations).length} Annotations {expanded.annotations ? '▾' : '▸'}</div>
          </div>
          {expanded.annotations && (
            <div className="pod-detail-list">
              {Object.entries(annotations).map(([key, value]) => <span key={key} className="inline-chip mono">{key}={String(value)}</span>)}
            </div>
          )}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Pod Volumes</h4>
        </div>
        {volumes.length === 0 ? (
          <div className="dim">No volumes defined</div>
        ) : (
          <div className="pod-properties-table">
            {volumes.map((volume: any) => (
              <div key={volume.name} className="pod-property-row">
                <div className="pod-property-label">{volume.projected ? 'Projected' : volume.configMap ? 'ConfigMap' : volume.secret ? 'Secret' : volume.emptyDir ? 'EmptyDir' : 'Volume'}</div>
                <div className="pod-property-value">{volume.name}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Containers</h4>
        </div>
        <div className="container-overview-list">
          {containers.map((container: any) => {
            const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
            const ports = Array.isArray(container.ports) ? container.ports : [];
            const envs = Array.isArray(container.env) ? container.env : [];
            const resources = container.resources ?? {};
            const requests = formatResourceBlock(resources.requests);
            const limits = formatResourceBlock(resources.limits);
            return (
              <div key={container.name} className="container-card">
                <div className="container-card-title"><span className="container-dot ok" />{container.name}</div>
                <div className="pod-properties-table">
                  <div className="pod-property-row"><div className="pod-property-label">Status</div><div className="pod-property-value status-running">running, ready</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Image</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? '-'}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Ports</div><div className="pod-property-value">{ports.length ? ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') : '-'}</div></div>
                  <div className="pod-property-row expandable" onClick={() => toggle(`env-${container.name}`)}><div className="pod-property-label">Environment</div><div className="pod-property-value linkish">{envs.length} Environmental Variables {expanded[`env-${container.name}`] ? '▾' : '▸'}</div></div>
                  {expanded[`env-${container.name}`] && (
                    <div className="pod-detail-list">
                      {envs.map((env: any, index: number) => <span key={`${container.name}-env-${index}`} className="inline-chip mono">{env.name}{env.value !== undefined ? `=${env.value}` : '=valueFrom'}</span>)}
                    </div>
                  )}
                  <div className="pod-property-row expandable" onClick={() => toggle(`mounts-${container.name}`)}><div className="pod-property-label">Mounts</div><div className="pod-property-value linkish">{mounts.length} Mounts {expanded[`mounts-${container.name}`] ? '▾' : '▸'}</div></div>
                  {expanded[`mounts-${container.name}`] && (
                    <div className="pod-detail-list">
                      {mounts.map((m: any, index: number) => <span key={`${container.name}-mount-${index}`} className="inline-chip mono">{m.mountPath} from {m.name}{m.readOnly ? ' (ro)' : ''}</span>)}
                    </div>
                  )}
                  <div className="pod-property-row"><div className="pod-property-label">Requests</div><div className="pod-property-value">{requests}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Limits</div><div className="pod-property-value">{limits}</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Vulnerabilities</h4>
        </div>
        <div className="security-placeholder">
          To perform automatic scanning, k8sexplorer Security Center requires enabling the Trivy Operator. This view is a placeholder until a vulnerability provider is integrated.
        </div>
        <div className="pod-properties-table" style={{ marginTop: 12 }}>
          {containers.map((container: any) => (
            <div key={container.name} className="pod-property-row">
              <div className="pod-property-label">Images</div>
              <div className="pod-property-value"><span className="linkish">{container.image ?? container.name}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Events</h4>
        </div>
        {eventsQuery.isLoading && <div className="dim">Loading events…</div>}
        {!eventsQuery.isLoading && relatedEvents.length === 0 && <div className="dim">No events found</div>}
        {relatedEvents.length > 0 && (
          <div className="pod-properties-table">
            {relatedEvents.slice(0, 20).map((event: any, index) => (
              <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                <div className="pod-property-label"><span className={`event-badge ${String(event.type ?? 'Normal').toLowerCase()}`}>{event.type ?? 'Normal'}</span> {event.reason ?? 'Event'}</div>
                <div className="pod-property-value">{event.message ?? '-'} <span className="dim event-time">{formatEventTime(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeploymentOverviewTab({ deployment }: { deployment: K8sObject }) {
  const labels = deployment.metadata?.labels ?? {};
  const annotations = deployment.metadata?.annotations ?? {};
  const conditions = Array.isArray(deployment.status?.conditions)
    ? (deployment.status.conditions as Array<{ type?: string; status?: string }>).filter((c) => c.status === 'True')
    : [];
  const containers = Array.isArray(deployment.spec?.template?.spec?.containers)
    ? deployment.spec.template.spec.containers
    : [];

  const properties: Array<[string, string]> = [
    ['Created', formatCreated(deployment.metadata?.creationTimestamp)],
    ['Name', deployment.metadata?.name ?? '-'],
    ['Namespace', deployment.metadata?.namespace ?? '-'],
    ['Labels', `${Object.keys(labels).length} Labels`],
    ['Replicas', `${deployment.status?.readyReplicas ?? 0}/${deployment.spec?.replicas ?? 0}`],
    ['Updated Replicas', `${deployment.status?.updatedReplicas ?? 0}`],
    ['Available Replicas', `${deployment.status?.availableReplicas ?? 0}`],
    ['Conditions', conditions.map((c) => c.type).join(', ') || '-'],
    ['Strategy', deployment.spec?.strategy?.type ?? '-'],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Properties</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className="pod-property-value">{value}</div>
            </div>
          ))}
          <div className="pod-property-row">
            <div className="pod-property-label">Annotations</div>
            <div className="pod-property-value">{Object.keys(annotations).length} Annotations</div>
          </div>
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Containers</h4>
        </div>
        <div className="container-overview-list">
          {containers.map((container: any) => {
            const ports = Array.isArray(container.ports) ? container.ports : [];
            const resources = container.resources ?? {};
            return (
              <div key={container.name} className="container-card">
                <div className="container-card-title"><span className="container-dot ok" />{container.name}</div>
                <div className="pod-properties-table">
                  <div className="pod-property-row"><div className="pod-property-label">Image</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? '-'}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Ports</div><div className="pod-property-value">{ports.length ? ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') : '-'}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Requests</div><div className="pod-property-value">{formatResourceBlock(resources.requests)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Limits</div><div className="pod-property-value">{formatResourceBlock(resources.limits)}</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WorkloadOverviewTab({ resource, plural }: { resource: K8sObject; plural: string }) {
  const labels = resource.metadata?.labels ?? {};
  const conditions = Array.isArray(resource.status?.conditions)
    ? (resource.status.conditions as Array<{ type?: string; status?: string }>)
        .filter((condition) => condition.status === 'True')
        .map((condition) => condition.type)
        .join(', ')
    : '-';

  const containers = Array.isArray(resource.spec?.template?.spec?.containers)
    ? resource.spec.template.spec.containers
    : [];

  const propsByType: Record<string, Array<[string, string]>> = {
    daemonsets: [
      ['Created', formatCreated(resource.metadata?.creationTimestamp)],
      ['Name', resource.metadata?.name ?? '-'],
      ['Namespace', resource.metadata?.namespace ?? '-'],
      ['Desired', String(resource.status?.desiredNumberScheduled ?? 0)],
      ['Current', String(resource.status?.currentNumberScheduled ?? 0)],
      ['Ready', String(resource.status?.numberReady ?? 0)],
      ['Up-to-date', String(resource.status?.updatedNumberScheduled ?? 0)],
      ['Available', String(resource.status?.numberAvailable ?? 0)],
      ['Node Selector', resource.spec?.template?.spec?.nodeSelector ? Object.entries(resource.spec.template.spec.nodeSelector).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '-'],
      ['Conditions', conditions],
    ],
    statefulsets: [
      ['Created', formatCreated(resource.metadata?.creationTimestamp)],
      ['Name', resource.metadata?.name ?? '-'],
      ['Namespace', resource.metadata?.namespace ?? '-'],
      ['Desired', String(resource.spec?.replicas ?? 0)],
      ['Current', String(resource.status?.currentReplicas ?? 0)],
      ['Ready', String(resource.status?.readyReplicas ?? 0)],
      ['Update Strategy', resource.spec?.updateStrategy?.type ?? '-'],
      ['Service Name', resource.spec?.serviceName ?? '-'],
      ['Conditions', conditions],
    ],
    replicasets: [
      ['Created', formatCreated(resource.metadata?.creationTimestamp)],
      ['Name', resource.metadata?.name ?? '-'],
      ['Namespace', resource.metadata?.namespace ?? '-'],
      ['Pods', `${resource.status?.readyReplicas ?? 0}/${resource.spec?.replicas ?? 0}`],
      ['Replicas', String(resource.spec?.replicas ?? 0)],
      ['Conditions', conditions],
    ],
    jobs: [
      ['Created', formatCreated(resource.metadata?.creationTimestamp)],
      ['Name', resource.metadata?.name ?? '-'],
      ['Namespace', resource.metadata?.namespace ?? '-'],
      ['Completions', `${resource.status?.succeeded ?? 0}/${resource.spec?.completions ?? 1}`],
      ['Parallelism', String(resource.spec?.parallelism ?? 1)],
      ['Active', String(resource.status?.active ?? 0)],
      ['Conditions', conditions],
    ],
    cronjobs: [
      ['Created', formatCreated(resource.metadata?.creationTimestamp)],
      ['Name', resource.metadata?.name ?? '-'],
      ['Namespace', resource.metadata?.namespace ?? '-'],
      ['Schedule', resource.spec?.schedule ?? '-'],
      ['Suspend', String(Boolean(resource.spec?.suspend))],
      ['Active', String(Array.isArray(resource.status?.active) ? resource.status.active.length : resource.status?.active ?? 0)],
      ['Last Schedule', formatCreated(resource.status?.lastScheduleTime)],
      ['Time Zone', resource.spec?.timeZone ?? '-'],
    ],
  };

  const properties = propsByType[plural] ?? [
    ['Created', formatCreated(resource.metadata?.creationTimestamp)],
    ['Name', resource.metadata?.name ?? '-'],
    ['Namespace', resource.metadata?.namespace ?? '-'],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Properties</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className="pod-property-value">{value}</div>
            </div>
          ))}
          <div className="pod-property-row">
            <div className="pod-property-label">Labels</div>
            <div className="pod-property-value">{Object.keys(labels).length} Labels</div>
          </div>
        </div>
      </div>

      {containers.length > 0 && (
        <div className="pod-section">
          <div className="pod-section-header">
            <h4>Containers</h4>
          </div>
          <div className="container-overview-list">
            {containers.map((container: any) => (
              <div key={container.name} className="container-card">
                <div className="container-card-title"><span className="container-dot ok" />{container.name}</div>
                <div className="pod-properties-table">
                  <div className="pod-property-row"><div className="pod-property-label">Image</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? '-'}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Ports</div><div className="pod-property-value">{Array.isArray(container.ports) && container.ports.length ? container.ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') : '-'}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Requests</div><div className="pod-property-value">{formatResourceBlock(container.resources?.requests)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">Limits</div><div className="pod-property-value">{formatResourceBlock(container.resources?.limits)}</div></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatCreated(createdAt?: string): string {
  if (!createdAt) return '-';
  const created = new Date(createdAt);
  const diffMs = Date.now() - created.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diffMs / (1000 * 60)) % 60);
  const ago = days > 0 ? `${days}d ${hours}h ${minutes}m ago` : `${hours}h ${minutes}m ago`;
  return `${ago} (${created.toLocaleString()})`;
}

function formatResourceBlock(resources?: Record<string, string>): string {
  if (!resources || Object.keys(resources).length === 0) return '-';
  return Object.entries(resources)
    .map(([key, value]) => `${key.toUpperCase()}: ${value}`)
    .join(', ');
}

function windowMs(window: '1h' | '6h' | '24h'): number {
  if (window === '6h') return 6 * 60 * 60 * 1000;
  if (window === '24h') return 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function buildMetricPath(points: Array<{ at: number; value: number }>, kind: 'usage'): string {
  if (points.length === 0) return '';
  const min = points[0].at;
  const max = points[points.length - 1].at || min + 1;
  const peak = Math.max(...points.map((p) => p.value), 1);
  return points
    .map((point, index) => {
      const x = ((point.at - min) / Math.max(max - min, 1)) * 720;
      const y = 220 - (point.value / peak) * 180;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mi`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
  return `${bytes.toFixed(0)} B`;
}

function parseCpuToMillicores(value?: string): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1_000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
}

function parseMemoryToBytes(value?: string): number {
  if (!value) return 0;
  const match = /^([0-9.]+)([KMGTE]i|[kMGTPE]|m)?$/.exec(value);
  if (!match) return Number(value) || 0;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const factors: Record<string, number> = { '': 1, k: 1_000, M: 1_000_000, G: 1_000_000_000, T: 1_000_000_000_000, P: 1_000_000_000_000_000, E: 1_000_000_000_000_000_000, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6, m: 0.001 };
  return amount * (factors[unit] ?? 1);
}

function sumContainerResources(containers: any[], key: 'requests' | 'limits') {
  return containers.reduce(
    (sum, container) => ({
      cpuMillicores: sum.cpuMillicores + parseCpuToMillicores(container.resources?.[key]?.cpu),
      memoryBytes: sum.memoryBytes + parseMemoryToBytes(container.resources?.[key]?.memory),
    }),
    { cpuMillicores: 0, memoryBytes: 0 },
  );
}

function formatEventTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return `${date.toLocaleString()}`;
}

function YamlTab({
  plural,
  name,
  scope,
  onSaved,
}: {
  plural: string;
  name: string;
  scope: Scope;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const { canWrite } = usePermissions();

  const yamlQuery = useQuery({
    queryKey: ['yaml', plural, name, scope.namespace],
    queryFn: () => api.getResourceYaml(plural, name, scope),
  });

  const value = draft || yamlQuery.data?.yaml || '';

  const save = useMutation({
    mutationFn: () => api.putResourceYaml(plural, name, value, scope),
    onSuccess: () => {
      setMessage('Saved successfully.');
      onSaved();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  return (
    <div className="drawer-body">
      <div className="actions-bar">
        {canWrite ? (
          <>
            <button className="primary" onClick={() => save.mutate()} disabled={save.isPending || yamlQuery.isLoading}>
              💾 Save
            </button>
            <button onClick={() => { setDraft(''); yamlQuery.refetch(); setMessage(''); }}>Revert</button>
          </>
        ) : (
          <span className="dim">Read-only — your role cannot edit this resource.</span>
        )}
        {message && <span className={save.isError ? 'badge danger' : 'badge ok'}>{message}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="yaml"
          theme="vs-dark"
          value={value}
          onChange={(v) => setDraft(v ?? '')}
          options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, readOnly: !canWrite }}
        />
      </div>
    </div>
  );
}

function SecretTab({ name, scope }: { name: string; scope: Scope }) {
  const reveal = useQuery({
    queryKey: ['secret-reveal', name, scope.namespace],
    queryFn: () => api.revealSecret(name, scope),
  });

  if (reveal.isLoading) return <div className="empty">Decoding…</div>;
  if (reveal.isError) return <div className="notice error">{(reveal.error as Error).message}</div>;

  return (
    <div style={{ padding: 14, overflow: 'auto' }}>
      <p className="dim">Decoded values (server-side, requires ALLOW_SECRET_REVEAL=true)</p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(reveal.data?.data ?? {}).map(([k, v]) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfigLikeDetailsTab({
  kind,
  object,
  scope,
  onChanged,
}: {
  kind: 'configmaps' | 'secrets';
  object: K8sObject;
  scope: Scope;
  onChanged: () => void;
}) {
  const name = object.metadata?.name ?? '';
  const labels = object.metadata?.labels ?? {};
  const annotations = object.metadata?.annotations ?? {};
  const { canWrite } = usePermissions();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  const eventsQuery = useQuery({
    queryKey: ['resource-events', kind, scope.context, scope.namespace, name],
    enabled: !!scope.context && !!scope.namespace && !!name,
    queryFn: () => api.listResource('events', scope),
  });

  useEffect(() => {
    const source = (object as any).data ?? {};
    const next = Object.fromEntries(
      Object.entries(source).map(([key, value]) => {
        if (kind !== 'secrets') return [key, String(value ?? '')];
        const raw = String(value ?? '');
        try {
          return [key, atob(raw)];
        } catch {
          return [key, raw];
        }
      }),
    );
    setDraft(next);
    setOriginalKeys(Object.keys(next));
    setVisibleSecrets({});
  }, [kind, object]);

  const save = useMutation({
    mutationFn: () =>
      kind === 'secrets'
        ? api.putSecretData(name, draft, scope)
        : api.putConfigMapData(name, draft, scope),
    onSuccess: () => {
      setMessage('Saved successfully.');
      onChanged();
    },
    onError: (error) => setMessage((error as Error).message),
  });

  const relatedEvents = (eventsQuery.data?.items ?? []).filter(
    (event) => ((event as any).involvedObject?.name as string | undefined) === name,
  );

  const setKey = (fromKey: string, toKey: string) => {
    const trimmed = toKey.trim();
    if (!trimmed || fromKey === trimmed) return;
    setDraft((current) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(current)) {
        if (k === fromKey) next[trimmed] = v;
        else next[k] = v;
      }
      return next;
    });
    setVisibleSecrets((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, fromKey)) return current;
      const next = { ...current };
      const visibility = next[fromKey];
      delete next[fromKey];
      next[trimmed] = visibility;
      return next;
    });
  };

  const setValue = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const removeKey = (key: string) => {
    const warning = [
      `Delete key "${key}" from this ${kind === 'secrets' ? 'secret' : 'config map'}?`,
      '',
      'This change is local until you click Save.',
    ].join('\n');
    if (!confirm(warning)) return;

    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setVisibleSecrets((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const addRow = () => {
    const base = 'new_key';
    let nextKey = base;
    let n = 1;
    while (Object.prototype.hasOwnProperty.call(draft, nextKey)) {
      nextKey = `${base}_${n++}`;
    }
    setDraft((current) => ({ ...current, [nextKey]: '' }));
    if (kind === 'secrets') {
      setVisibleSecrets((current) => ({ ...current, [nextKey]: false }));
    }
  };

  const toggleSecretVisibility = (key: string) => {
    setVisibleSecrets((current) => ({ ...current, [key]: !current[key] }));
  };

  const encodedDisplay = (value: string) => {
    try {
      return btoa(value);
    } catch {
      return value;
    }
  };

  const handleSave = () => {
    const removedKeys = originalKeys.filter((key) => !Object.prototype.hasOwnProperty.call(draft, key));
    if (removedKeys.length > 0) {
      const preview = removedKeys.slice(0, 5).join(', ');
      const more = removedKeys.length > 5 ? ` and ${removedKeys.length - 5} more` : '';
      const warning = [
        `You removed ${removedKeys.length} key(s): ${preview}${more}.`,
        '',
        'Saving will permanently remove them from Kubernetes.',
        'Do you want to continue?',
      ].join('\n');
      if (!confirm(warning)) return;
    }
    save.mutate();
  };

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Properties</h4>
        </div>
        <div className="pod-properties-table">
          <div className="pod-property-row"><div className="pod-property-label">Created</div><div className="pod-property-value">{formatCreated(object.metadata?.creationTimestamp)}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">Name</div><div className="pod-property-value">{name || '-'}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">Namespace</div><div className="pod-property-value">{object.metadata?.namespace ?? '-'}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">Labels</div><div className="pod-property-value">{Object.keys(labels).length} Labels</div></div>
          <div className="pod-property-row"><div className="pod-property-label">Annotations</div><div className="pod-property-value">{Object.keys(annotations).length} Annotations</div></div>
          {kind === 'secrets' && <div className="pod-property-row"><div className="pod-property-label">Type</div><div className="pod-property-value">{(object as any).type ?? '-'}</div></div>}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Events</h4>
        </div>
        {eventsQuery.isLoading && <div className="dim">Loading events…</div>}
        {!eventsQuery.isLoading && relatedEvents.length === 0 && <div className="dim">No events found</div>}
        {relatedEvents.length > 0 && (
          <div className="pod-properties-table">
            {relatedEvents.slice(0, 10).map((event: any, index) => (
              <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                <div className="pod-property-label">{event.reason ?? event.type ?? 'Event'}</div>
                <div className="pod-property-value">{event.message ?? '-'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>Data</h4>
          {canWrite && (
            <div className="metrics-toolbar">
              <button onClick={addRow}>+ Add</button>
              <button className="primary" onClick={handleSave} disabled={save.isPending}>Save</button>
            </div>
          )}
        </div>
        {message && <div className={`notice ${save.isError ? 'error' : ''}`}>{message}</div>}
        <div className="kv-editor">
          {Object.keys(draft).length === 0 && <div className="dim">No data entries</div>}
          {Object.entries(draft).map(([key, value]) => (
            <div key={key} className="kv-editor-row">
              <input
                className="kv-key"
                value={key}
                onChange={(event) => setKey(key, event.target.value)}
                readOnly={!canWrite}
              />
              <textarea
                className="kv-value mono"
                value={kind === 'secrets' && !visibleSecrets[key] ? encodedDisplay(value) : value}
                onChange={(event) => setValue(key, event.target.value)}
                rows={2}
                readOnly={!canWrite || (kind === 'secrets' && !visibleSecrets[key])}
              />
              {kind === 'secrets' && (
                <button
                  className={`icon-action eye-toggle ${visibleSecrets[key] ? 'is-visible' : 'is-hidden'}`}
                  title={visibleSecrets[key] ? 'Hide secret value' : 'Show secret value'}
                  aria-label={visibleSecrets[key] ? 'Hide secret value' : 'Show secret value'}
                  onClick={() => toggleSecretVisibility(key)}
                >
                  👁
                </button>
              )}
              {canWrite && (
                <button
                  className={`icon-action ${kind === 'secrets' ? 'danger' : ''}`}
                  title="Delete key"
                  aria-label="Delete key"
                  onClick={() => removeKey(key)}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
