import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getDesktopEmail, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { getMetricsWorker } from '../utils/workerRuntime';
import { useWatchedResourceList } from '../hooks/useWatchedResourceList';
import { LogsPanel } from './LogsPanel';
import { ExecTerminal } from './ExecTerminal';
import { DeploymentActions } from './DeploymentActions';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastViewport';
import type { OpenDeploymentLogsTerminalRequest, OpenPodLogsTerminalRequest, OpenPodTerminalRequest } from './TerminalDock';
import { ValidateYamlButton, YamlValidationNotice } from './YamlValidation';
import { TreeDisclosure } from './TreeDisclosure';
import { uiText } from '../text';

// Kinds without a hand-built Overview tab (pods/deployments/workload controllers,
// configmaps/secrets) fall back here: a data-driven Properties view plus, for the
// kinds with list-shaped specs, a card list per entry (ports, rules, subjects, ...).
const GENERIC_OVERVIEW_PLURALS = new Set([
  'services',
  'endpointslices',
  'endpoints',
  'ingresses',
  'ingressclasses',
  'networkpolicies',
  'resourcequotas',
  'limitranges',
  'horizontalpodautoscalers',
  'poddisruptionbudgets',
  'leases',
  'serviceaccounts',
  'roles',
  'rolebindings',
  'customresourcedefinitions',
  'persistentvolumeclaims',
  'storageclasses',
  'namespaces',
  'events',
  'nodes',
]);

interface Props {
  plural: string;
  object: K8sObject;
  scope: Scope;
  initialTab?: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenPodTerminal?: (request: OpenPodTerminalRequest) => void;
  onOpenPodLogsTerminal?: (request: OpenPodLogsTerminalRequest) => void;
  onOpenDeploymentLogsTerminal?: (request: OpenDeploymentLogsTerminalRequest) => void;
}

export function ResourceDetail({
  plural,
  object,
  scope,
  initialTab,
  onClose,
  onChanged,
  onOpenPodTerminal,
  onOpenPodLogsTerminal,
  onOpenDeploymentLogsTerminal,
}: Props) {
  const name = object.metadata!.name!;
  const ns = object.metadata?.namespace;
  const opScope: Scope = { ...scope, namespace: ns };
  const { canWrite, canDelete } = usePermissions();
  const confirm = useConfirm();
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
    if (plural === 'deployments') t.unshift('logs');
    if (plural === 'deployments') t.unshift('actions');
    if (plural === 'deployments') t.unshift('overview');
    if (plural === 'pods') t.unshift('overview');
    if (['daemonsets', 'statefulsets', 'replicasets', 'jobs', 'cronjobs'].includes(plural)) t.unshift('overview');
    if (plural === 'configmaps' || plural === 'secrets') t.unshift('details');
    if (GENERIC_OVERVIEW_PLURALS.has(plural)) t.unshift('overview');
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
                onClick={async () => {
                  const ok = await confirm({
                    title: uiText.confirmDialog.deleteTitle,
                    message: uiText.confirmDialog.deleteQuestion(`${plural.slice(0, -1) || plural} "${name}"`),
                    details: plural === 'pods' ? uiText.resourceDetail.destructiveActionNotice : undefined,
                  });
                  if (!ok) return;
                  del.mutate();
                }}
                disabled={del.isPending}
              >
                🗑
              </button>
            )}
          </div>
          <button onClick={onClose}>{uiText.common.close}</button>
        </div>

        <div className="tabs">
          {tabs.map((t) => (
            <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'yaml'
                ? uiText.resourceDetail.yaml
                : t === 'overview'
                ? uiText.resourceDetail.overview
                : t === 'details'
                ? uiText.resourceDetail.details
                : t === 'actions'
                ? uiText.resourceDetail.actionsTab
                : t === 'logs'
                ? uiText.resourceDetail.logs
                : t === 'exec'
                ? uiText.resourceDetail.execTab
                : uiText.resourceDetail.secretTab}
            </div>
          ))}
        </div>

        {tab === 'overview' && plural === 'pods' && <PodOverviewTab pod={currentObject} scope={scope} />}
        {tab === 'overview' && plural === 'deployments' && <DeploymentOverviewTab deployment={currentObject} scope={scope} />}
        {tab === 'overview' && ['daemonsets', 'statefulsets', 'replicasets', 'jobs', 'cronjobs'].includes(plural) && (
          <WorkloadOverviewTab resource={currentObject} plural={plural} />
        )}
        {tab === 'overview' && GENERIC_OVERVIEW_PLURALS.has(plural) && (
          <GenericOverviewTab resource={currentObject} plural={plural} />
        )}
        {tab === 'details' && (plural === 'configmaps' || plural === 'secrets') && (
          <ConfigLikeDetailsTab
            kind={plural}
            object={currentObject}
            scope={opScope}
            isLoadingData={!fullObjectQuery.data && fullObjectQuery.isLoading}
            onChanged={onChanged}
          />
        )}
        {tab === 'yaml' && (
          <YamlTab plural={plural} name={name} scope={opScope} onSaved={onChanged} />
        )}
        {tab === 'actions' && plural === 'deployments' && (
          <DeploymentActions
            deployment={currentObject}
            scope={scope}
            onChanged={onChanged}
            onOpenLogs={() => setTab('logs')}
          />
        )}
        {tab === 'logs' && plural === 'deployments' && (
          <LogsPanel kind="deployment" deployment={currentObject} context={scope.context} />
        )}
        {tab === 'logs' && plural === 'pods' && (
          <LogsPanel
            kind="pod"
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
  const [activeMetric, setActiveMetric] = useState<'cpu' | 'memory'>('cpu');
  const [metricsHistory, setMetricsHistory] = useState<Array<{ at: number; cpuMillicores: number; memoryBytes: number }>>([]);
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
    setMetricsHistory((current) => {
      const cutoff = Date.now() - windowMs('24h');
      const withoutDuplicate = current.filter((entry) => entry.at >= cutoff && entry.at !== at);
      return [...withoutDuplicate, { at, cpuMillicores: totalCpuMillicores, memoryBytes: totalMemoryBytes }].slice(-5760);
    });
  }, [metricsData, totalCpuMillicores, totalMemoryBytes]);

  const chartEnd = Date.now();
  const chartStart = chartEnd - windowMs(metricsWindow);
  const activeHistory = metricsHistory
    .filter((sample) => sample.at >= chartStart && sample.at <= chartEnd)
    .map((sample) => ({ at: sample.at, value: activeMetric === 'memory' ? sample.memoryBytes : sample.cpuMillicores }));
  const activeRequest = activeMetric === 'memory' ? requestTotals.memoryBytes : requestTotals.cpuMillicores;
  const activeLimit = activeMetric === 'memory' ? limitTotals.memoryBytes : limitTotals.cpuMillicores;
  const activeChartMax = Math.max(activeRequest, activeLimit, ...activeHistory.map((sample) => sample.value), 1);
  const barWidth = Math.max(1, Math.min(10, (15_000 / windowMs(metricsWindow)) * 680 * 0.75));
  const requestY = 220 - (activeRequest / activeChartMax) * 180;
  const limitY = 220 - (activeLimit / activeChartMax) * 180;
  const activeMetricValue = activeMetric === 'cpu' ? `${totalCpuMillicores.toFixed(0)}m` : formatBytes(totalMemoryBytes);

  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  const properties: Array<[string, string]> = [
    [uiText.resourceDetail.created, formatCreated(pod.metadata?.creationTimestamp)],
    [uiText.resourceDetail.name, pod.metadata?.name ?? uiText.resourceDetail.dash],
    [uiText.applications.namespace, pod.metadata?.namespace ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.labels, uiText.resourceDetail.labelsCount(Object.keys(labels).length)],
    [uiText.resourceDetail.controlled, owner?.kind && owner?.name ? `${owner.kind} ${owner.name}` : uiText.resourceDetail.dash],
    [uiText.resourceDetail.status, pod.status?.phase ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.node, pod.spec?.nodeName ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.podIP, pod.status?.podIP ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.podIPs, podIps.join(', ') || uiText.resourceDetail.dash],
    [uiText.resourceDetail.serviceAccount, pod.spec?.serviceAccountName ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.qosClass, pod.status?.qosClass ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.conditions, conditions.map((c) => c.type).join(', ') || uiText.resourceDetail.dash],
    [uiText.resourceDetail.tolerations, tolerations.length ? String(tolerations.length) : uiText.resourceDetail.dash],
    [uiText.resourceDetail.podAntiAffinities, antiAffinities.length ? uiText.resourceDetail.ruleCount(antiAffinities.length) : uiText.resourceDetail.dash],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.resourceUsage}</h4>
          <div className="metrics-toolbar">
            <select value={metricsWindow} onChange={(e) => setMetricsWindow(e.target.value as '1h' | '6h' | '24h')}>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
            </select>
          </div>
        </div>
        <div className="metrics-note">{uiText.resourceDetail.metricsDescription}</div>
        <div className="deployment-metric-selector" role="group" aria-label={uiText.resourceDetail.metricSelection}>
          <button className={activeMetric === 'cpu' ? 'active' : ''} onClick={() => setActiveMetric('cpu')}>{uiText.resourceDetail.cpuUsage}</button>
          <button className={activeMetric === 'memory' ? 'active' : ''} onClick={() => setActiveMetric('memory')}>{uiText.resourceDetail.memoryUsage}</button>
        </div>
        <div className="deployment-metric-chart">
          <div className="deployment-metric-heading">
            <span>{activeMetric === 'cpu' ? uiText.resourceDetail.cpuUsage : uiText.resourceDetail.memoryUsage}</span>
            <div className="deployment-metric-heading-values">
              <span><span className={`metrics-swatch ${activeMetric === 'memory' ? 'memory' : 'usage'}`} /><b>{uiText.resourceDetail.current}</b> <strong>{activeMetricValue}</strong></span>
              <span><span className="metrics-swatch request" /><b>{uiText.resourceDetail.requests}</b> <strong>{formatMetricValue(activeRequest, activeMetric)}</strong></span>
              <span><span className="metrics-swatch limit" /><b>{uiText.resourceDetail.limits}</b> <strong>{formatMetricValue(activeLimit, activeMetric)}</strong></span>
            </div>
          </div>
          <div className="deployment-metric-plot">
            <div className="metrics-grid" />
            <svg className="metrics-svg" viewBox="0 0 720 240" preserveAspectRatio="none">
              {activeRequest > 0 && <line x1="0" y1={requestY} x2="720" y2={requestY} className="metrics-line request" />}
              {activeLimit > 0 && <line x1="0" y1={limitY} x2="720" y2={limitY} className="metrics-line limit" />}
              {activeHistory.map((sample) => {
                const height = Math.max(1, (sample.value / activeChartMax) * 180);
                const x = 20 + ((sample.at - chartStart) / Math.max(chartEnd - chartStart, 1)) * 680 - barWidth / 2;
                return (
                  <rect key={sample.at} x={x} y={220 - height} width={barWidth} height={height} className={`metrics-bar ${activeMetric}`}>
                    <title>{`${new Date(sample.at).toLocaleTimeString()}: ${formatMetricValue(sample.value, activeMetric)}`}</title>
                  </rect>
                );
              })}
            </svg>
            <div className="deployment-metric-axis" aria-hidden="true">
              <span>{formatChartTime(chartStart, metricsWindow)}</span>
              <span>{formatChartTime(chartStart + (chartEnd - chartStart) / 2, metricsWindow)}</span>
              <span>{uiText.resourceDetail.now}</span>
            </div>
          </div>
        </div>
        <div className="metrics-note pod-metrics-state">
          {metricsState !== 'live' && <span className="metrics-status">{metricsState}</span>}
          {metricsError && <span className="metrics-error">{uiText.resourceDetail.errorPrefix} {metricsError}</span>}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.properties}</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className={`pod-property-value ${label === uiText.resourceDetail.status && value === 'Running' ? 'status-running' : ''}`}>
                {value}
              </div>
            </div>
          ))}
          <div className="pod-property-row expandable" onClick={() => toggle('labels')}>
            <div className="pod-property-label">{uiText.resourceDetail.labels}</div>
            <div className="pod-property-value linkish">{uiText.resourceDetail.labelsCount(Object.keys(labels).length)} <TreeDisclosure collapsed={!expanded.labels} className="inline-disclosure" /></div>
          </div>
          {expanded.labels && (
            <div className="pod-detail-list">
              {Object.entries(labels).map(([key, value]) => <span key={key} className="inline-chip mono">{key}={value}</span>)}
            </div>
          )}
          <div className="pod-property-row expandable" onClick={() => toggle('annotations')}>
            <div className="pod-property-label">{uiText.resourceDetail.annotations}</div>
            <div className="pod-property-value linkish">{uiText.resourceDetail.annotationsCount(Object.keys(annotations).length)} <TreeDisclosure collapsed={!expanded.annotations} className="inline-disclosure" /></div>
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
          <h4>{uiText.resourceDetail.podVolumesTitle}</h4>
        </div>
        {volumes.length === 0 ? (
          <div className="dim">{uiText.resourceDetail.noVolumesDefined}</div>
        ) : (
          <div className="pod-properties-table">
            {volumes.map((volume: any) => (
              <div key={volume.name} className="pod-property-row">
                <div className="pod-property-label">{volume.projected ? uiText.resourceDetail.volumeProjected : volume.configMap ? uiText.resourceDetail.volumeConfigMap : volume.secret ? uiText.resourceDetail.volumeSecretType : volume.emptyDir ? uiText.resourceDetail.volumeEmptyDir : uiText.resourceDetail.volumeDefault}</div>
                <div className="pod-property-value">{volume.name}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.containers}</h4>
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
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.status}</div><div className="pod-property-value status-running">{uiText.resourceDetail.runningReady}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.image}</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? uiText.resourceDetail.dash}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.ports}</div><div className="pod-property-value">{ports.length ? ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? uiText.resourceDetail.tcp}`).join(', ') : uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row expandable" onClick={() => toggle(`env-${container.name}`)}><div className="pod-property-label">{uiText.resourceDetail.environment}</div><div className="pod-property-value linkish">{uiText.resourceDetail.environmentalVariablesCount(envs.length)} <TreeDisclosure collapsed={!expanded[`env-${container.name}`]} className="inline-disclosure" /></div></div>
                  {expanded[`env-${container.name}`] && (
                    <div className="pod-detail-list">
                      {envs.map((env: any, index: number) => <span key={`${container.name}-env-${index}`} className="inline-chip mono">{env.name}{env.value !== undefined ? `=${env.value}` : '=valueFrom'}</span>)}
                    </div>
                  )}
                  <div className="pod-property-row expandable" onClick={() => toggle(`mounts-${container.name}`)}><div className="pod-property-label">{uiText.resourceDetail.mounts}</div><div className="pod-property-value linkish">{uiText.resourceDetail.mountsCount(mounts.length)} <TreeDisclosure collapsed={!expanded[`mounts-${container.name}`]} className="inline-disclosure" /></div></div>
                  {expanded[`mounts-${container.name}`] && (
                    <div className="pod-detail-list">
                      {mounts.map((m: any, index: number) => <span key={`${container.name}-mount-${index}`} className="inline-chip mono">{uiText.resourceDetail.mountFrom(m.mountPath, m.name)}{m.readOnly ? uiText.resourceDetail.readOnlySuffix : ''}</span>)}
                    </div>
                  )}
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.requests}</div><div className="pod-property-value">{requests}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.limits}</div><div className="pod-property-value">{limits}</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.vulnerabilities}</h4>
        </div>
        <div className="security-placeholder">
          {uiText.resourceDetail.vulnerabilitiesPlaceholder}
        </div>
        <div className="pod-properties-table" style={{ marginTop: 12 }}>
          {containers.map((container: any) => (
            <div key={container.name} className="pod-property-row">
              <div className="pod-property-label">{uiText.resourceDetail.images}</div>
              <div className="pod-property-value"><span className="linkish">{container.image ?? container.name}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.events}</h4>
        </div>
        {eventsQuery.isLoading && <div className="dim">{uiText.resourceDetail.loadingEvents}</div>}
        {!eventsQuery.isLoading && relatedEvents.length === 0 && <div className="dim">{uiText.resourceDetail.noEventsFound}</div>}
        {relatedEvents.length > 0 && (
          <div className="pod-properties-table">
            {relatedEvents.slice(0, 20).map((event: any, index) => (
              <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                <div className="pod-property-label"><span className={`event-badge ${String(event.type ?? uiText.resourceDetail.normalEventType).toLowerCase()}`}>{event.type ?? uiText.resourceDetail.normalEventType}</span> {event.reason ?? uiText.resourceDetail.eventReasonFallback}</div>
                <div className="pod-property-value">{event.message ?? uiText.resourceDetail.dash} <span className="dim event-time">{formatEventTime(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeploymentOverviewTab({ deployment, scope }: { deployment: K8sObject; scope: Scope }) {
  const [metricsWindow, setMetricsWindow] = useState<'1h' | '6h' | '24h'>('1h');
  const [activeMetric, setActiveMetric] = useState<'cpu' | 'memory'>('cpu');
  const [metricsHistory, setMetricsHistory] = useState<Array<{ at: number; cpuMillicores: number; memoryBytes: number }>>([]);
  const labels = deployment.metadata?.labels ?? {};
  const annotations = deployment.metadata?.annotations ?? {};
  const conditions = Array.isArray(deployment.status?.conditions)
    ? (deployment.status.conditions as Array<{ type?: string; status?: string; reason?: string; message?: string; lastUpdateTime?: string }>)
    : [];
  const containers = Array.isArray(deployment.spec?.template?.spec?.containers)
    ? deployment.spec.template.spec.containers
    : [];
  const podSpec = deployment.spec?.template?.spec ?? {};
  const strategy = deployment.spec?.strategy ?? {};
  const rollingUpdate = strategy.rollingUpdate ?? {};
  const selector = deployment.spec?.selector?.matchLabels ?? {};
  const ownerReferences = Array.isArray((deployment.metadata as any)?.ownerReferences)
    ? (deployment.metadata as any).ownerReferences
    : [];
  const deploymentNamespace = deployment.metadata?.namespace;
  const deploymentScope: Scope = { ...scope, namespace: deploymentNamespace };
  const overviewEnabled = !!scope.context && !!deploymentNamespace;

  // Pods and events for this deployment are listed once and then kept fresh by
  // the same watch-worker websocket ResourceTable uses elsewhere in the app,
  // instead of each polling with its own repeating GET.
  const podsQuery = useWatchedResourceList('deployment-overview', 'pods', deploymentScope, overviewEnabled);
  const eventsQuery = useWatchedResourceList('deployment-overview', 'events', deploymentScope, overviewEnabled);

  const relatedPods = useMemo(() => {
    if (Object.keys(selector).length === 0) return [];
    return (podsQuery.data?.items ?? []).filter((pod) => {
      const podLabels = pod.metadata?.labels ?? {};
      return Object.entries(selector).every(([key, value]) => podLabels[key] === String(value));
    });
  }, [podsQuery.data, selector]);

  // Metrics-server has no watch/streaming API, so this one still has to poll.
  const deploymentDataQuery = useQuery({
    queryKey: [
      'deployment-overview-data',
      scope.context,
      deploymentNamespace,
      deployment.metadata?.name,
      relatedPods.map((pod) => pod.metadata?.name).join(','),
    ],
    enabled: overviewEnabled && Object.keys(selector).length > 0 && podsQuery.isSuccess,
    refetchInterval: 15_000,
    queryFn: async () => {
      const podTargets = relatedPods.flatMap((pod) => pod.metadata?.name
        ? [{ name: pod.metadata.name, namespace: pod.metadata.namespace }]
        : []);
      const metricsResponse = podTargets.length
        ? await api.getPodMetricsBatch(podTargets, deploymentScope)
        : { items: [] };
      const memoryByPod = metricsResponse.items.map((item) => ({
        name: item.name,
        cpuMillicores: item.snapshot?.containers.reduce((sum, container) => sum + container.cpuMillicores, 0),
        memoryBytes: item.snapshot?.containers.reduce((sum, container) => sum + container.memoryBytes, 0),
        error: item.error,
      }));
      const sampledAt = metricsResponse.items
        .map((item) => item.snapshot?.timestamp ? new Date(item.snapshot.timestamp).getTime() : 0)
        .reduce((latest, timestamp) => Math.max(latest, timestamp), 0) || Date.now();
      return { memoryByPod, sampledAt };
    },
  });
  const memoryByPod = deploymentDataQuery.data?.memoryByPod ?? [];
  const deploymentEvents = useMemo(() => {
    const podNames = new Set(relatedPods.map((pod) => pod.metadata?.name).filter(Boolean));
    const podUids = new Set(relatedPods.map((pod) => pod.metadata?.uid).filter(Boolean));
    return (eventsQuery.data?.items ?? [])
      .filter((event) => {
        const involved = (event as any).involvedObject ?? (event as any).regarding;
        const isDeployment = involved?.uid === deployment.metadata?.uid
          || (involved?.kind === 'Deployment' && involved?.name === deployment.metadata?.name);
        const isPod = podUids.has(involved?.uid) || (involved?.kind === 'Pod' && podNames.has(involved?.name));
        return isDeployment || isPod;
      })
      .sort((a, b) => {
        const aTime = new Date((a.lastTimestamp ?? a.eventTime ?? a.metadata?.creationTimestamp ?? '') as string).getTime();
        const bTime = new Date((b.lastTimestamp ?? b.eventTime ?? b.metadata?.creationTimestamp ?? '') as string).getTime();
        return bTime - aTime;
      });
  }, [eventsQuery.data, relatedPods, deployment.metadata?.uid, deployment.metadata?.name]);
  const totalCpuMillicores = memoryByPod.reduce((sum, pod) => sum + (pod.cpuMillicores ?? 0), 0);
  const totalMemoryBytes = memoryByPod.reduce((sum, pod) => sum + (pod.memoryBytes ?? 0), 0);
  const reportingPods = memoryByPod.filter((pod) => pod.memoryBytes !== undefined).length;
  const podRequests = sumContainerResources(containers, 'requests');
  const podLimits = sumContainerResources(containers, 'limits');
  const matchedPodCount = memoryByPod.length;

  useEffect(() => {
    const sampledAt = deploymentDataQuery.data?.sampledAt;
    if (!sampledAt) return;
    setMetricsHistory((current) => {
      const cutoff = Date.now() - windowMs('24h');
      const withoutDuplicate = current.filter((sample) => sample.at >= cutoff && sample.at !== sampledAt);
      return [...withoutDuplicate, { at: sampledAt, cpuMillicores: totalCpuMillicores, memoryBytes: totalMemoryBytes }].slice(-5760);
    });
  }, [deploymentDataQuery.data?.sampledAt, totalCpuMillicores, totalMemoryBytes]);

  const chartEnd = Date.now();
  const chartStart = chartEnd - windowMs(metricsWindow);
  const visibleMetricHistory = metricsHistory.filter((sample) => sample.at >= chartStart && sample.at <= chartEnd);
  const activeHistory = visibleMetricHistory.map((sample) => ({
    at: sample.at,
    value: activeMetric === 'memory' ? sample.memoryBytes : sample.cpuMillicores,
  }));
  const activeRequest = activeMetric === 'memory'
    ? podRequests.memoryBytes * matchedPodCount
    : podRequests.cpuMillicores * matchedPodCount;
  const activeLimit = activeMetric === 'memory'
    ? podLimits.memoryBytes * matchedPodCount
    : podLimits.cpuMillicores * matchedPodCount;
  const activeChartMax = Math.max(activeRequest, activeLimit, ...activeHistory.map((sample) => sample.value), 1);
  const chartBars = activeHistory;
  const barWidth = Math.max(1, Math.min(10, (15_000 / windowMs(metricsWindow)) * 680 * 0.75));
  const requestY = 220 - (activeRequest / activeChartMax) * 180;
  const limitY = 220 - (activeLimit / activeChartMax) * 180;
  const activeMetricValue = activeMetric === 'cpu'
    ? `${totalCpuMillicores.toFixed(0)}m`
    : formatBytes(totalMemoryBytes);

  const properties: Array<[string, string]> = [
    [uiText.resourceDetail.created, formatCreated(deployment.metadata?.creationTimestamp)],
    [uiText.resourceDetail.name, deployment.metadata?.name ?? uiText.resourceDetail.dash],
    [uiText.applications.namespace, deployment.metadata?.namespace ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.uid, String(deployment.metadata?.uid ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.controlled, ownerReferences.map((owner: any) => `${owner.kind ?? ''}/${owner.name ?? ''}`).join(', ') || uiText.resourceDetail.dash],
    [uiText.resourceDetail.labels, formatKeyValues(labels)],
    [uiText.resourceDetail.annotations, formatKeyValues(annotations)],
    [uiText.resourceDetail.selector, formatKeyValues(selector)],
  ];

  const rolloutProperties: Array<[string, string]> = [
    [uiText.resourceDetail.desired, `${deployment.spec?.replicas ?? 0}`],
    [uiText.resourceDetail.current, `${deployment.status?.replicas ?? 0}`],
    [uiText.resourceDetail.ready, `${deployment.status?.readyReplicas ?? 0}`],
    [uiText.resourceDetail.updatedReplicas, `${deployment.status?.updatedReplicas ?? 0}`],
    [uiText.resourceDetail.availableReplicas, `${deployment.status?.availableReplicas ?? 0}`],
    [uiText.resourceDetail.unavailableReplicas, `${deployment.status?.unavailableReplicas ?? 0}`],
    [uiText.resourceDetail.revision, String(annotations['deployment.kubernetes.io/revision'] ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.generation, String((deployment.metadata as any)?.generation ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.observedGeneration, String(deployment.status?.observedGeneration ?? uiText.resourceDetail.dash)],
  ];

  const configurationProperties: Array<[string, string]> = [
    [uiText.resourceDetail.strategy, strategy.type ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.maxSurge, String(rollingUpdate.maxSurge ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.maxUnavailable, String(rollingUpdate.maxUnavailable ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.minReadySeconds, String(deployment.spec?.minReadySeconds ?? 0)],
    [uiText.resourceDetail.progressDeadlineSeconds, String(deployment.spec?.progressDeadlineSeconds ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.revisionHistoryLimit, String(deployment.spec?.revisionHistoryLimit ?? uiText.resourceDetail.dash)],
    [uiText.resourceDetail.paused, String(Boolean(deployment.spec?.paused))],
    [uiText.resourceDetail.serviceAccount, podSpec.serviceAccountName ?? uiText.resourceDetail.dash],
    [uiText.resourceDetail.nodeSelector, formatKeyValues(podSpec.nodeSelector ?? {})],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.resourceUsage}</h4>
          <div className="metrics-toolbar">
            <select value={metricsWindow} onChange={(event) => setMetricsWindow(event.target.value as '1h' | '6h' | '24h')}>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
            </select>
            <button onClick={() => deploymentDataQuery.refetch()} disabled={deploymentDataQuery.isFetching}>{uiText.common.refresh}</button>
          </div>
        </div>
        <div className="metrics-note">{uiText.resourceDetail.deploymentMetricsDescription}</div>
        {deploymentDataQuery.isLoading && <div className="dim">{uiText.resourceDetail.loadingMetrics}</div>}
        {deploymentDataQuery.isError && <div className="metrics-error">{uiText.resourceDetail.metricsUnavailable}</div>}
        {!deploymentDataQuery.isLoading && !deploymentDataQuery.isError && (
          <>
            <div className="deployment-metric-selector" role="group" aria-label={uiText.resourceDetail.metricSelection}>
              <button className={activeMetric === 'cpu' ? 'active' : ''} onClick={() => setActiveMetric('cpu')}>{uiText.resourceDetail.cpuUsage}</button>
              <button className={activeMetric === 'memory' ? 'active' : ''} onClick={() => setActiveMetric('memory')}>{uiText.resourceDetail.memoryUsage}</button>
            </div>
            <div className="deployment-metric-chart">
              <div className="deployment-metric-heading">
                <span>{activeMetric === 'cpu' ? uiText.resourceDetail.cpuUsage : uiText.resourceDetail.memoryUsage}</span>
                <div className="deployment-metric-heading-values">
                  <span><span className={`metrics-swatch ${activeMetric === 'memory' ? 'memory' : 'usage'}`} /><b>{uiText.resourceDetail.current}</b> <strong>{activeMetricValue}</strong></span>
                  <span><span className="metrics-swatch request" /><b>{uiText.resourceDetail.requests}</b> <strong>{formatMetricValue(activeRequest, activeMetric)}</strong></span>
                  <span><span className="metrics-swatch limit" /><b>{uiText.resourceDetail.limits}</b> <strong>{formatMetricValue(activeLimit, activeMetric)}</strong></span>
                </div>
              </div>
              <div className="deployment-metric-plot">
                <div className="metrics-grid" />
                <svg className="metrics-svg" viewBox="0 0 720 240" preserveAspectRatio="none">
                  {activeRequest > 0 && <line x1="0" y1={requestY} x2="720" y2={requestY} className="metrics-line request" />}
                  {activeLimit > 0 && <line x1="0" y1={limitY} x2="720" y2={limitY} className="metrics-line limit" />}
                  {chartBars.map((sample) => {
                    const height = Math.max(1, (sample.value / activeChartMax) * 180);
                    const x = 20 + ((sample.at - chartStart) / Math.max(chartEnd - chartStart, 1)) * 680 - barWidth / 2;
                    return (
                      <rect
                        key={sample.at}
                        x={x}
                        y={220 - height}
                        width={barWidth}
                        height={height}
                        className={`metrics-bar ${activeMetric}`}
                      >
                        <title>{`${new Date(sample.at).toLocaleTimeString()}: ${formatMetricValue(sample.value, activeMetric)}`}</title>
                      </rect>
                    );
                  })}
                </svg>
                <div className="deployment-metric-axis" aria-hidden="true">
                  <span>{formatChartTime(chartStart, metricsWindow)}</span>
                  <span>{formatChartTime(chartStart + (chartEnd - chartStart) / 2, metricsWindow)}</span>
                  <span>{uiText.resourceDetail.now}</span>
                </div>
              </div>
            </div>
            <div className="deployment-pod-metrics-header">
              <h5>{uiText.resourceDetail.podsReporting}</h5>
              <span>{reportingPods}/{memoryByPod.length}</span>
            </div>
            <div className="overview-table-wrapper deployment-pod-metrics">
              <table className="overview-table">
                <thead><tr><th>{uiText.resourceDetail.pod}</th><th>{uiText.resourceDetail.cpuUsage}</th><th>{uiText.resourceDetail.memoryUsage}</th><th>{uiText.resourceDetail.status}</th></tr></thead>
                <tbody>
                  {memoryByPod.map((pod) => (
                    <tr key={pod.name}>
                      <td>{pod.name}</td>
                      <td>{pod.cpuMillicores !== undefined ? `${pod.cpuMillicores.toFixed(0)}m` : uiText.resourceDetail.dash}</td>
                      <td>{pod.memoryBytes !== undefined ? formatBytes(pod.memoryBytes) : uiText.resourceDetail.dash}</td>
                      <td className={pod.memoryBytes !== undefined ? 'status-running' : 'metrics-error'}>{pod.memoryBytes !== undefined ? uiText.resourceDetail.reporting : pod.error ?? uiText.resourceDetail.metricsUnavailable}</td>
                    </tr>
                  ))}
                  {memoryByPod.length === 0 && <tr><td colSpan={4} className="dim">{uiText.resourceDetail.noDeploymentPods}</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.properties}</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className="pod-property-value">{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header"><h4>{uiText.resourceDetail.rolloutStatus}</h4></div>
        <div className="overview-table-wrapper rollout-status-table">
          <table className="overview-table">
            <thead>
              <tr>{rolloutProperties.map(([label]) => <th key={label}>{label}</th>)}</tr>
            </thead>
            <tbody>
              <tr>{rolloutProperties.map(([label, value]) => <td key={label}>{value}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header"><h4>{uiText.resourceDetail.configuration}</h4></div>
        <div className="pod-properties-table">
          {configurationProperties.map(([label, value]) => (
            <div key={label} className="pod-property-row"><div className="pod-property-label">{label}</div><div className="pod-property-value">{value}</div></div>
          ))}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header"><h4>{uiText.resourceDetail.conditions}</h4></div>
        <div className="pod-properties-table">
          {conditions.length === 0 && <div className="dim">{uiText.resourceDetail.noConditions}</div>}
          {conditions.map((condition, index) => (
            <div key={`${condition.type ?? 'condition'}-${index}`} className="pod-property-row">
              <div className="pod-property-label">{condition.type ?? uiText.resourceDetail.dash} ({condition.status ?? uiText.resourceDetail.dash})</div>
              <div className="pod-property-value">{[condition.reason, condition.message, condition.lastUpdateTime && formatCreated(condition.lastUpdateTime)].filter(Boolean).join(' - ') || uiText.resourceDetail.dash}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.containers}</h4>
        </div>
        <div className="container-overview-list">
          {containers.map((container: any) => {
            const ports = Array.isArray(container.ports) ? container.ports : [];
            const env = Array.isArray(container.env) ? container.env : [];
            const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
            const resources = container.resources ?? {};
            return (
              <div key={container.name} className="container-card">
                <div className="container-card-title"><span className="container-dot ok" />{container.name}</div>
                <div className="pod-properties-table">
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.image}</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? uiText.resourceDetail.dash}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.ports}</div><div className="pod-property-value">{ports.length ? ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? uiText.resourceDetail.tcp}`).join(', ') : uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.imagePullPolicy}</div><div className="pod-property-value">{container.imagePullPolicy ?? uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.command}</div><div className="pod-property-value">{[...(container.command ?? []), ...(container.args ?? [])].join(' ') || uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.environment}</div><div className="pod-property-value">{env.length ? env.map((item: any) => item.value !== undefined ? `${item.name}=${item.value}` : `${item.name}=<valueFrom>`).join(', ') : uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.mounts}</div><div className="pod-property-value">{mounts.length ? mounts.map((mount: any) => `${mount.name}: ${mount.mountPath}${mount.readOnly ? uiText.resourceDetail.readOnlySuffix : ''}`).join(', ') : uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.requests}</div><div className="pod-property-value">{formatResourceBlock(resources.requests)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.limits}</div><div className="pod-property-value">{formatResourceBlock(resources.limits)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.readinessProbe}</div><div className="pod-property-value">{formatProbe(container.readinessProbe)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.livenessProbe}</div><div className="pod-property-value">{formatProbe(container.livenessProbe)}</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header"><h4>{uiText.resourceDetail.events}</h4></div>
        {eventsQuery.isLoading && <div className="dim">{uiText.resourceDetail.loadingEvents}</div>}
        {eventsQuery.isError && <div className="metrics-error">{(eventsQuery.error as Error).message}</div>}
        {!eventsQuery.isLoading && !eventsQuery.isError && deploymentEvents.length === 0 && <div className="dim">{uiText.resourceDetail.noEventsFound}</div>}
        {deploymentEvents.length > 0 && (
          <div className="pod-properties-table">
            {deploymentEvents.slice(0, 20).map((event: any, index) => (
              <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                <div className="pod-property-label"><span className={`event-badge ${String(event.type ?? uiText.resourceDetail.normalEventType).toLowerCase()}`}>{event.type ?? uiText.resourceDetail.normalEventType}</span> {event.reason ?? uiText.resourceDetail.eventReasonFallback}</div>
                <div className="pod-property-value">{event.message ?? uiText.resourceDetail.dash} <span className="dim event-time">{formatEventTime(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)}</span></div>
              </div>
            ))}
          </div>
        )}
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
    : uiText.resourceDetail.dash;

  const containers = Array.isArray(resource.spec?.template?.spec?.containers)
    ? resource.spec.template.spec.containers
    : [];

  const propsByType: Record<string, Array<[string, string]>> = {
    daemonsets: [
      [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
      [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
      [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.desired, String(resource.status?.desiredNumberScheduled ?? 0)],
      [uiText.resourceDetail.current, String(resource.status?.currentNumberScheduled ?? 0)],
      [uiText.resourceDetail.ready, String(resource.status?.numberReady ?? 0)],
      [uiText.resourceDetail.upToDate, String(resource.status?.updatedNumberScheduled ?? 0)],
      [uiText.resourceDetail.available, String(resource.status?.numberAvailable ?? 0)],
      [uiText.resourceDetail.nodeSelector, resource.spec?.template?.spec?.nodeSelector ? Object.entries(resource.spec.template.spec.nodeSelector).map(([k, v]) => `${k}=${String(v)}`).join(', ') : uiText.resourceDetail.dash],
      [uiText.resourceDetail.conditions, conditions],
    ],
    statefulsets: [
      [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
      [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
      [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.desired, String(resource.spec?.replicas ?? 0)],
      [uiText.resourceDetail.current, String(resource.status?.currentReplicas ?? 0)],
      [uiText.resourceDetail.ready, String(resource.status?.readyReplicas ?? 0)],
      [uiText.resourceDetail.updateStrategy, resource.spec?.updateStrategy?.type ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.serviceName, resource.spec?.serviceName ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.conditions, conditions],
    ],
    replicasets: [
      [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
      [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
      [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
      [uiText.applications.pods, `${resource.status?.readyReplicas ?? 0}/${resource.spec?.replicas ?? 0}`],
      [uiText.resourceDetail.replicas, String(resource.spec?.replicas ?? 0)],
      [uiText.resourceDetail.conditions, conditions],
    ],
    jobs: [
      [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
      [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
      [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.completions, `${resource.status?.succeeded ?? 0}/${resource.spec?.completions ?? 1}`],
      [uiText.resourceDetail.parallelism, String(resource.spec?.parallelism ?? 1)],
      [uiText.resourceDetail.active, String(resource.status?.active ?? 0)],
      [uiText.resourceDetail.conditions, conditions],
    ],
    cronjobs: [
      [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
      [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
      [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.schedule, resource.spec?.schedule ?? uiText.resourceDetail.dash],
      [uiText.resourceDetail.suspend, String(Boolean(resource.spec?.suspend))],
      [uiText.resourceDetail.active, String(Array.isArray(resource.status?.active) ? resource.status.active.length : resource.status?.active ?? 0)],
      [uiText.resourceDetail.lastSchedule, formatCreated(resource.status?.lastScheduleTime)],
      [uiText.resourceDetail.timeZone, resource.spec?.timeZone ?? uiText.resourceDetail.dash],
    ],
  };

  const properties = propsByType[plural] ?? [
    [uiText.resourceDetail.created, formatCreated(resource.metadata?.creationTimestamp)],
    [uiText.resourceDetail.name, resource.metadata?.name ?? uiText.resourceDetail.dash],
    [uiText.applications.namespace, resource.metadata?.namespace ?? uiText.resourceDetail.dash],
  ];

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.properties}</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className="pod-property-value">{value}</div>
            </div>
          ))}
          <div className="pod-property-row">
            <div className="pod-property-label">{uiText.resourceDetail.labels}</div>
            <div className="pod-property-value">{uiText.resourceDetail.labelsCount(Object.keys(labels).length)}</div>
          </div>
        </div>
      </div>

      {containers.length > 0 && (
        <div className="pod-section">
          <div className="pod-section-header">
            <h4>{uiText.resourceDetail.containers}</h4>
          </div>
          <div className="container-overview-list">
            {containers.map((container: any) => (
              <div key={container.name} className="container-card">
                <div className="container-card-title"><span className="container-dot ok" />{container.name}</div>
                <div className="pod-properties-table">
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.image}</div><div className="pod-property-value"><span className="inline-chip mono">{container.image ?? uiText.resourceDetail.dash}</span></div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.ports}</div><div className="pod-property-value">{Array.isArray(container.ports) && container.ports.length ? container.ports.map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol ?? uiText.resourceDetail.tcp}`).join(', ') : uiText.resourceDetail.dash}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.requests}</div><div className="pod-property-value">{formatResourceBlock(container.resources?.requests)}</div></div>
                  <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.limits}</div><div className="pod-property-value">{formatResourceBlock(container.resources?.limits)}</div></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type PropRow = [string, ReactNode];
type CardItem = { key: string; heading?: string; rows: PropRow[] };
type CardSection = { title: string; empty: string; items: CardItem[] };
type TableRow = { key: string; cells: ReactNode[] };
type TableSection = { title: string; empty: string; columns: string[]; rows: TableRow[] };
type Section = CardSection | TableSection;

function isTableSection(section: Section): section is TableSection {
  return 'columns' in section;
}

function joinKV(obj?: Record<string, unknown> | null): string {
  const entries = Object.entries(obj ?? {});
  return entries.length ? entries.map(([k, v]) => `${k}=${String(v)}`).join(', ') : uiText.resourceDetail.dash;
}

function joinList(list?: unknown[] | null): string {
  return Array.isArray(list) && list.length ? list.map((v) => String(v)).join(', ') : uiText.resourceDetail.dash;
}

// Visual-only hyperlink styling for cross-resource references (namespace, target
// pod, etc). Not yet wired to real navigation.
function LinkText({ children }: { children: ReactNode }) {
  return <span className="linkish">{children}</span>;
}

function refLabel(ref?: { kind?: string; name?: string } | null): ReactNode {
  if (!ref?.kind || !ref?.name) return uiText.resourceDetail.dash;
  return <LinkText>{`${ref.kind}/${ref.name}`}</LinkText>;
}

function OverviewCards({ title, empty, items }: { title: string; empty: string; items: CardItem[] }) {
  return (
    <div className="pod-section">
      <div className="pod-section-header">
        <h4>{title}</h4>
      </div>
      {items.length === 0 ? (
        <div className="dim">{empty}</div>
      ) : (
        <div className="container-overview-list">
          {items.map((item) => (
            <div key={item.key} className="container-card">
              {item.heading && <div className="container-card-title">{item.heading}</div>}
              <div className="pod-properties-table">
                {item.rows.map(([label, value]) => (
                  <div key={label} className="pod-property-row">
                    <div className="pod-property-label">{label}</div>
                    <div className="pod-property-value">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewTable({ title, empty, columns, rows }: TableSection) {
  return (
    <div className="pod-section">
      <div className="pod-section-header">
        <h4>{title}</h4>
      </div>
      {rows.length === 0 ? (
        <div className="dim">{empty}</div>
      ) : (
        <div className="overview-table-wrapper">
          <table className="overview-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Builds the Properties table plus, for kinds whose spec is fundamentally a list
// (ports, rules, subjects, versions, conditions...), one card-list section per list.
function buildGenericOverview(plural: string, r: any): { properties: PropRow[]; cardSections: Section[] } {
  const labels = r.metadata?.labels ?? {};
  const annotations = r.metadata?.annotations ?? {};
  const base: PropRow[] = [[uiText.resourceDetail.created, formatCreated(r.metadata?.creationTimestamp)], [uiText.resourceDetail.name, r.metadata?.name ?? uiText.resourceDetail.dash]];
  if (r.metadata?.namespace) base.push([uiText.applications.namespace, <LinkText>{r.metadata.namespace}</LinkText>]);
  base.push([uiText.resourceDetail.labels, joinKV(labels)], [uiText.resourceDetail.annotations, joinKV(annotations)]);

  const cardSections: Section[] = [];

  switch (plural) {
    case 'services': {
      const ports = Array.isArray(r.spec?.ports) ? r.spec.ports : [];
      const lbIngress = Array.isArray(r.status?.loadBalancer?.ingress) ? r.status.loadBalancer.ingress : [];
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.type, r.spec?.type ?? uiText.resourceDetail.clusterIP],
        [uiText.resourceDetail.clusterIpLabel, r.spec?.clusterIP ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.clusterIpsLabel, joinList(r.spec?.clusterIPs)],
        [uiText.resourceDetail.externalIPs, joinList(r.spec?.externalIPs)],
        [uiText.resourceDetail.loadBalancerIngress, lbIngress.length ? lbIngress.map((i: any) => i.ip ?? i.hostname).join(', ') : uiText.resourceDetail.dash],
        [uiText.resourceDetail.sessionAffinity, r.spec?.sessionAffinity ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.externalTrafficPolicy, r.spec?.externalTrafficPolicy ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.selector, joinKV(r.spec?.selector)],
      ];
      cardSections.push({
        title: uiText.resourceDetail.ports,
        empty: uiText.resourceDetail.noPortsDefined,
        columns: [uiText.resourceDetail.name, uiText.resourceDetail.colPort, uiText.resourceDetail.colTargetPort, uiText.resourceDetail.colProtocol, uiText.resourceDetail.colNodePort],
        rows: ports.map((p: any, i: number) => ({
          key: `${p.name ?? p.port ?? i}`,
          cells: [p.name ?? uiText.resourceDetail.dash, String(p.port ?? uiText.resourceDetail.dash), String(p.targetPort ?? uiText.resourceDetail.dash), p.protocol ?? uiText.resourceDetail.tcp, p.nodePort ? String(p.nodePort) : uiText.resourceDetail.dash],
        })),
      });
      return { properties, cardSections };
    }

    case 'endpointslices': {
      const ports = Array.isArray(r.ports) ? r.ports : [];
      const endpoints = Array.isArray(r.endpoints) ? r.endpoints : [];
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.addressType, r.addressType ?? uiText.resourceDetail.dash],
      ];
      cardSections.push({
        title: uiText.resourceDetail.ports,
        empty: uiText.resourceDetail.noPortsDefined,
        columns: [uiText.resourceDetail.name, uiText.resourceDetail.colPort, uiText.resourceDetail.colProtocol],
        rows: ports.map((p: any, i: number) => ({
          key: `${p.name ?? p.port ?? i}`,
          cells: [p.name ?? uiText.resourceDetail.dash, String(p.port ?? uiText.resourceDetail.dash), p.protocol ?? uiText.resourceDetail.tcp],
        })),
      });
      cardSections.push({
        title: uiText.resourceDetail.endpointsTitle,
        empty: uiText.resourceDetail.noEndpoints,
        columns: [uiText.resourceDetail.addresses, uiText.resourceDetail.ready, uiText.resourceDetail.hostname, uiText.resourceDetail.colNodeName, uiText.portForwarding.target],
        rows: endpoints.map((e: any, i: number) => ({
          key: String(i),
          cells: [
            joinList(e.addresses),
            String(e.conditions?.ready ?? uiText.resourceDetail.dash),
            e.hostname ?? uiText.resourceDetail.dash,
            e.nodeName ?? uiText.resourceDetail.dash,
            refLabel(e.targetRef),
          ],
        })),
      });
      return { properties, cardSections };
    }

    case 'endpoints': {
      const subsets = Array.isArray(r.subsets) ? r.subsets : [];
      const addressRows: TableRow[] = [];
      const notReadyRows: TableRow[] = [];
      const portRows: TableRow[] = [];
      subsets.forEach((s: any, si: number) => {
        (s.addresses ?? []).forEach((a: any, ai: number) => {
          addressRows.push({ key: `${si}-${ai}`, cells: [a.ip ?? uiText.resourceDetail.dash, a.hostname ?? uiText.resourceDetail.dash, refLabel(a.targetRef)] });
        });
        (s.notReadyAddresses ?? []).forEach((a: any, ai: number) => {
          notReadyRows.push({ key: `${si}-${ai}`, cells: [a.ip ?? uiText.resourceDetail.dash, a.hostname ?? uiText.resourceDetail.dash, refLabel(a.targetRef)] });
        });
        (s.ports ?? []).forEach((p: any, pi: number) => {
          portRows.push({ key: `${si}-${pi}`, cells: [String(p.port ?? uiText.resourceDetail.dash), p.name ?? uiText.resourceDetail.dash, p.protocol ?? uiText.resourceDetail.tcp] });
        });
      });
      cardSections.push({
        title: uiText.resourceDetail.addresses,
        empty: uiText.resourceDetail.noAddresses,
        columns: [uiText.resourceDetail.colIP, uiText.resourceDetail.hostname, uiText.portForwarding.target],
        rows: addressRows,
      });
      if (notReadyRows.length) {
        cardSections.push({
          title: uiText.resourceDetail.notReadyAddressesTitle,
          empty: uiText.resourceDetail.noNotReadyAddresses,
          columns: [uiText.resourceDetail.colIP, uiText.resourceDetail.hostname, uiText.portForwarding.target],
          rows: notReadyRows,
        });
      }
      cardSections.push({
        title: uiText.resourceDetail.ports,
        empty: uiText.resourceDetail.noPortsDefined,
        columns: [uiText.resourceDetail.colPort, uiText.resourceDetail.name, uiText.resourceDetail.colProtocol],
        rows: portRows,
      });
      return { properties: base, cardSections };
    }

    case 'ingresses': {
      const rules = Array.isArray(r.spec?.rules) ? r.spec.rules : [];
      const tls = Array.isArray(r.spec?.tls) ? r.spec.tls : [];
      const lbIngress = Array.isArray(r.status?.loadBalancer?.ingress) ? r.status.loadBalancer.ingress : [];
      const defaultBackend = r.spec?.defaultBackend;
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.ingressClass, r.spec?.ingressClassName ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.defaultBackend, defaultBackend?.service ? `${defaultBackend.service.name}:${defaultBackend.service.port?.number ?? defaultBackend.service.port?.name ?? uiText.resourceDetail.dash}` : uiText.resourceDetail.dash],
        [uiText.resourceDetail.tlsHosts, joinList(tls.flatMap((t: any) => t.hosts ?? []))],
        [uiText.resourceDetail.loadBalancerIngress, lbIngress.length ? lbIngress.map((i: any) => i.ip ?? i.hostname).join(', ') : uiText.resourceDetail.dash],
      ];
      const rows: TableRow[] = [];
      rules.forEach((rule: any, ri: number) => {
        const paths = Array.isArray(rule.http?.paths) ? rule.http.paths : [];
        paths.forEach((p: any, pi: number) => {
          rows.push({
            key: `${ri}-${pi}`,
            cells: [
              rule.host ?? uiText.resourceDetail.wildcard,
              p.path ?? '/',
              p.pathType ?? uiText.resourceDetail.dash,
              p.backend?.service?.name ?? uiText.resourceDetail.dash,
              String(p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? uiText.resourceDetail.dash),
            ],
          });
        });
      });
      cardSections.push({
        title: uiText.resourceDetail.rulesTitle,
        empty: uiText.resourceDetail.noRulesDefined,
        columns: [uiText.resourceDetail.colHost, uiText.resourceDetail.colPath, uiText.resourceDetail.colPathType, uiText.resourceDetail.colBackendService, uiText.resourceDetail.colBackendPort],
        rows,
      });
      return { properties, cardSections };
    }

    case 'ingressclasses': {
      const params = r.spec?.parameters;
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.controller, r.spec?.controller ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.isDefaultClass, annotations['ingressclass.kubernetes.io/is-default-class'] ?? uiText.resourceDetail.falseLower],
        [uiText.resourceDetail.parameters, params ? `${params.kind ?? ''} ${params.name ?? ''}${params.apiGroup ? ` (${params.apiGroup})` : ''}`.trim() : uiText.resourceDetail.dash],
      ];
      return { properties, cardSections };
    }

    case 'networkpolicies': {
      const ingress = Array.isArray(r.spec?.ingress) ? r.spec.ingress : [];
      const egress = Array.isArray(r.spec?.egress) ? r.spec.egress : [];
      const peerSummary = (peers: any[]) =>
        !peers?.length
          ? uiText.resourceDetail.allCap
          : peers
              .map((p) => (p.podSelector ? uiText.resourceDetail.podsPeerSummary(joinKV(p.podSelector.matchLabels)) : p.namespaceSelector ? uiText.resourceDetail.namespacePeerSummary(joinKV(p.namespaceSelector.matchLabels)) : p.ipBlock ? uiText.resourceDetail.ipPeerSummary(p.ipBlock.cidr) : uiText.resourceDetail.dash))
              .join('; ');
      const portSummary = (ports: any[]) => (ports?.length ? ports.map((p: any) => `${p.protocol ?? uiText.resourceDetail.tcp}/${p.port ?? uiText.resourceDetail.allLower}`).join(', ') : uiText.resourceDetail.allCap);
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.podSelector, joinKV(r.spec?.podSelector?.matchLabels)],
        [uiText.resourceDetail.policyTypes, joinList(r.spec?.policyTypes)],
      ];
      cardSections.push({
        title: uiText.resourceDetail.ingressRulesTitle,
        empty: uiText.resourceDetail.noIngressRules,
        columns: [uiText.resourceDetail.colRule, uiText.resourceDetail.colFrom, uiText.resourceDetail.ports],
        rows: ingress.map((rule: any, i: number) => ({
          key: String(i),
          cells: [uiText.resourceDetail.ruleLabel(i + 1), peerSummary(rule.from), portSummary(rule.ports)],
        })),
      });
      cardSections.push({
        title: uiText.resourceDetail.egressRulesTitle,
        empty: uiText.resourceDetail.noEgressRules,
        columns: [uiText.resourceDetail.colRule, uiText.resourceDetail.colTo, uiText.resourceDetail.ports],
        rows: egress.map((rule: any, i: number) => ({
          key: String(i),
          cells: [uiText.resourceDetail.ruleLabel(i + 1), peerSummary(rule.to), portSummary(rule.ports)],
        })),
      });
      return { properties, cardSections };
    }

    case 'resourcequotas': {
      const hard = r.status?.hard ?? r.spec?.hard ?? {};
      const used = r.status?.used ?? {};
      cardSections.push({
        title: uiText.resourceDetail.hardLimitsUsedTitle,
        empty: uiText.resourceDetail.noQuotaEntries,
        items: Object.keys(hard).map((key) => ({
          key,
          heading: key,
          rows: [
            [uiText.resourceDetail.hard, String(hard[key])],
            [uiText.resourceDetail.used, String(used[key] ?? uiText.resourceDetail.dash)],
          ],
        })),
      });
      return { properties: base, cardSections };
    }

    case 'limitranges': {
      const limits = Array.isArray(r.spec?.limits) ? r.spec.limits : [];
      cardSections.push({
        title: uiText.resourceDetail.limits,
        empty: uiText.resourceDetail.noLimitsDefined,
        items: limits.map((l: any, i: number) => ({
          key: String(i),
          heading: l.type ?? uiText.resourceDetail.limitHeading(i + 1),
          rows: [
            [uiText.resourceDetail.default, formatResourceBlock(l.default)],
            [uiText.resourceDetail.defaultRequest, formatResourceBlock(l.defaultRequest)],
            [uiText.resourceDetail.max, formatResourceBlock(l.max)],
            [uiText.resourceDetail.min, formatResourceBlock(l.min)],
          ],
        })),
      });
      return { properties: base, cardSections };
    }

    case 'horizontalpodautoscalers': {
      const metrics = Array.isArray(r.spec?.metrics) ? r.spec.metrics : [];
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.scaleTarget, r.spec?.scaleTargetRef ? `${r.spec.scaleTargetRef.kind}/${r.spec.scaleTargetRef.name}` : uiText.resourceDetail.dash],
        [uiText.resourceDetail.minReplicas, String(r.spec?.minReplicas ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.maxReplicas, String(r.spec?.maxReplicas ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.currentReplicas, String(r.status?.currentReplicas ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.desiredReplicas, String(r.status?.desiredReplicas ?? uiText.resourceDetail.dash)],
      ];
      cardSections.push({
        title: uiText.resourceDetail.metrics,
        empty: uiText.resourceDetail.noMetricsConfigured,
        items: metrics.map((m: any, i: number) => ({
          key: String(i),
          heading: m.type ?? uiText.resourceDetail.metricHeading(i + 1),
          rows: [
            [uiText.portForwarding.resource, m.resource?.name ?? m.pods?.metric?.name ?? m.object?.metric?.name ?? uiText.resourceDetail.dash],
            [uiText.portForwarding.target, m.resource?.target?.averageUtilization ? `${m.resource.target.averageUtilization}%` : m.resource?.target?.averageValue ?? uiText.resourceDetail.dash],
          ],
        })),
      });
      return { properties, cardSections };
    }

    case 'poddisruptionbudgets': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.minAvailable, r.spec?.minAvailable !== undefined ? String(r.spec.minAvailable) : uiText.resourceDetail.dash],
        [uiText.resourceDetail.maxUnavailable, r.spec?.maxUnavailable !== undefined ? String(r.spec.maxUnavailable) : uiText.resourceDetail.dash],
        [uiText.resourceDetail.selector, joinKV(r.spec?.selector?.matchLabels)],
        [uiText.resourceDetail.currentHealthy, String(r.status?.currentHealthy ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.desiredHealthy, String(r.status?.desiredHealthy ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.disruptionsAllowed, String(r.status?.disruptionsAllowed ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.expectedPods, String(r.status?.expectedPods ?? uiText.resourceDetail.dash)],
      ];
      return { properties, cardSections };
    }

    case 'leases': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.holderIdentity, r.spec?.holderIdentity ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.leaseDurationSeconds, String(r.spec?.leaseDurationSeconds ?? uiText.resourceDetail.dash)],
        [uiText.resourceDetail.acquireTime, r.spec?.acquireTime ? formatCreated(r.spec.acquireTime) : uiText.resourceDetail.dash],
        [uiText.resourceDetail.renewTime, r.spec?.renewTime ? formatCreated(r.spec.renewTime) : uiText.resourceDetail.dash],
        [uiText.resourceDetail.leaseTransitions, String(r.spec?.leaseTransitions ?? uiText.resourceDetail.dash)],
      ];
      return { properties, cardSections };
    }

    case 'serviceaccounts': {
      const secrets = Array.isArray(r.secrets) ? r.secrets : [];
      const imagePullSecrets = Array.isArray(r.imagePullSecrets) ? r.imagePullSecrets : [];
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.automountToken, String(r.automountServiceAccountToken ?? true)],
        [uiText.resourceDetail.secretsLabel, joinList(secrets.map((s: any) => s.name))],
        [uiText.resourceDetail.imagePullSecrets, joinList(imagePullSecrets.map((s: any) => s.name))],
      ];
      return { properties, cardSections };
    }

    case 'roles': {
      const rules = Array.isArray(r.rules) ? r.rules : [];
      cardSections.push({
        title: uiText.resourceDetail.rulesTitle,
        empty: uiText.resourceDetail.noRulesDefined,
        items: rules.map((rule: any, i: number) => ({
          key: String(i),
          heading: uiText.resourceDetail.ruleLabel(i + 1),
          rows: [
            [uiText.resourceDetail.apiGroups, joinList(rule.apiGroups)],
            [uiText.resourceDetail.resourcesLabel, joinList(rule.resources)],
            [uiText.resourceDetail.resourceNames, joinList(rule.resourceNames)],
            [uiText.resourceDetail.verbs, joinList(rule.verbs)],
          ],
        })),
      });
      return { properties: base, cardSections };
    }

    case 'rolebindings': {
      const subjects = Array.isArray(r.subjects) ? r.subjects : [];
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.roleRef, r.roleRef ? `${r.roleRef.kind}/${r.roleRef.name}` : uiText.resourceDetail.dash],
      ];
      cardSections.push({
        title: uiText.resourceDetail.subjectsTitle,
        empty: uiText.resourceDetail.noSubjects,
        items: subjects.map((s: any, i: number) => ({
          key: String(i),
          heading: s.name ?? uiText.resourceDetail.subjectHeading(i + 1),
          rows: [
            [uiText.resourceDetail.kind, s.kind ?? uiText.resourceDetail.dash],
            [uiText.applications.namespace, s.namespace ?? uiText.resourceDetail.dash],
            [uiText.resourceDetail.apiGroup, s.apiGroup ?? uiText.resourceDetail.dash],
          ],
        })),
      });
      return { properties, cardSections };
    }

    case 'customresourcedefinitions': {
      const versions = Array.isArray(r.spec?.versions) ? r.spec.versions : [];
      const names = r.spec?.names ?? {};
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.group, r.spec?.group ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.scope, r.spec?.scope ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.kind, names.kind ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.pluralLabel, names.plural ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.singular, names.singular ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.shortNames, joinList(names.shortNames)],
      ];
      cardSections.push({
        title: uiText.resourceDetail.versionsTitle,
        empty: uiText.resourceDetail.noVersions,
        items: versions.map((v: any) => ({
          key: v.name,
          heading: v.name,
          rows: [
            [uiText.resourceDetail.served, String(v.served ?? false)],
            [uiText.resourceDetail.storage, String(v.storage ?? false)],
            [uiText.resourceDetail.deprecated, String(v.deprecated ?? false)],
          ],
        })),
      });
      return { properties, cardSections };
    }

    case 'persistentvolumeclaims': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.status, r.status?.phase ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.accessModes, joinList(r.spec?.accessModes)],
        [uiText.resourceDetail.storageClass, r.spec?.storageClassName ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.volumeName, r.spec?.volumeName ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.volumeMode, r.spec?.volumeMode ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.requestedStorage, r.spec?.resources?.requests?.storage ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.capacity, r.status?.capacity?.storage ?? uiText.resourceDetail.dash],
      ];
      return { properties, cardSections };
    }

    case 'storageclasses': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.provisioner, r.provisioner ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.reclaimPolicy, r.reclaimPolicy ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.volumeBindingMode, r.volumeBindingMode ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.allowVolumeExpansion, String(r.allowVolumeExpansion ?? false)],
        [uiText.resourceDetail.mountOptions, joinList(r.mountOptions)],
        [uiText.resourceDetail.isDefaultClass, annotations['storageclass.kubernetes.io/is-default-class'] ?? uiText.resourceDetail.falseLower],
        [uiText.resourceDetail.parameters, joinKV(r.parameters)],
      ];
      return { properties, cardSections };
    }

    case 'namespaces': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.status, r.status?.phase ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.finalizers, joinList(r.spec?.finalizers)],
      ];
      return { properties, cardSections };
    }

    case 'events': {
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.type, r.type ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.reason, r.reason ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.message, r.message ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.count, String(r.count ?? 1)],
        [uiText.resourceDetail.firstSeen, formatCreated(r.firstTimestamp ?? r.eventTime)],
        [uiText.resourceDetail.lastSeen, formatCreated(r.lastTimestamp ?? r.eventTime)],
        [uiText.resourceDetail.involvedObjectLabel, r.involvedObject ? `${r.involvedObject.kind}/${r.involvedObject.name}` : uiText.resourceDetail.dash],
        [uiText.resourceDetail.source, r.source?.component ?? r.reportingComponent ?? uiText.resourceDetail.dash],
      ];
      return { properties, cardSections };
    }

    case 'nodes': {
      const conditions = Array.isArray(r.status?.conditions) ? r.status.conditions : [];
      const taints = Array.isArray(r.spec?.taints) ? r.spec.taints : [];
      const addresses = Array.isArray(r.status?.addresses) ? r.status.addresses : [];
      const info = r.status?.nodeInfo ?? {};
      const readyCondition = conditions.find((c: any) => c.type === 'Ready');
      const properties: PropRow[] = [
        ...base,
        [uiText.resourceDetail.ready, readyCondition?.status === 'True' ? uiText.resourceDetail.trueLabel : uiText.resourceDetail.falseLabel],
        [uiText.resourceDetail.unschedulable, String(r.spec?.unschedulable ?? false)],
        [uiText.resourceDetail.internalIP, addresses.find((a: any) => a.type === 'InternalIP')?.address ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.externalIP, addresses.find((a: any) => a.type === 'ExternalIP')?.address ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.hostname, addresses.find((a: any) => a.type === 'Hostname')?.address ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.podCIDR, r.spec?.podCIDR ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.kubeletVersion, info.kubeletVersion ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.osImage, info.osImage ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.containerRuntime, info.containerRuntimeVersion ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.kernelVersion, info.kernelVersion ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.architecture, info.architecture ?? uiText.resourceDetail.dash],
        [uiText.resourceDetail.capacity, formatResourceBlock(r.status?.capacity)],
        [uiText.resourceDetail.allocatable, formatResourceBlock(r.status?.allocatable)],
      ];
      cardSections.push({
        title: uiText.resourceDetail.conditions,
        empty: uiText.resourceDetail.noConditionsReported,
        items: conditions.map((c: any) => ({
          key: c.type,
          heading: c.type,
          rows: [
            [uiText.resourceDetail.status, c.status ?? uiText.resourceDetail.dash],
            [uiText.resourceDetail.reason, c.reason ?? uiText.resourceDetail.dash],
            [uiText.resourceDetail.message, c.message ?? uiText.resourceDetail.dash],
          ],
        })),
      });
      cardSections.push({
        title: uiText.resourceDetail.taintsTitle,
        empty: uiText.resourceDetail.noTaints,
        items: taints.map((t: any, i: number) => ({
          key: String(i),
          heading: t.key,
          rows: [
            [uiText.resourceDetail.value, t.value ?? uiText.resourceDetail.dash],
            [uiText.resourceDetail.effect, t.effect ?? uiText.resourceDetail.dash],
          ],
        })),
      });
      return { properties, cardSections };
    }

    default:
      return { properties: base, cardSections };
  }
}

function GenericOverviewTab({ resource, plural }: { resource: K8sObject; plural: string }) {
  const { properties, cardSections } = useMemo(() => buildGenericOverview(plural, resource as any), [plural, resource]);
  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.properties}</h4>
        </div>
        <div className="pod-properties-table">
          {properties.map(([label, value]) => (
            <div key={label} className="pod-property-row">
              <div className="pod-property-label">{label}</div>
              <div className="pod-property-value">{value}</div>
            </div>
          ))}
        </div>
      </div>
      {cardSections.map((section) =>
        isTableSection(section) ? (
          <OverviewTable key={section.title} title={section.title} empty={section.empty} columns={section.columns} rows={section.rows} />
        ) : (
          <OverviewCards key={section.title} title={section.title} empty={section.empty} items={section.items} />
        ),
      )}
    </div>
  );
}

function formatCreated(createdAt?: string): string {
  if (!createdAt) return uiText.resourceDetail.dash;
  const created = new Date(createdAt);
  const diffMs = Date.now() - created.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diffMs / (1000 * 60)) % 60);
  const ago = days > 0
    ? `${days}d ${hours}h ${minutes}m ${uiText.resourceDetail.agoSuffix}`
    : `${hours}h ${minutes}m ${uiText.resourceDetail.agoSuffix}`;
  return `${ago} (${created.toLocaleString()})`;
}

function formatResourceBlock(resources?: Record<string, string>): string {
  if (!resources || Object.keys(resources).length === 0) return uiText.resourceDetail.dash;
  return Object.entries(resources)
    .map(([key, value]) => `${key.toUpperCase()}: ${value}`)
    .join(', ');
}

function formatKeyValues(values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  return entries.length ? entries.map(([key, value]) => `${key}=${String(value)}`).join(', ') : uiText.resourceDetail.dash;
}

function formatProbe(probe?: any): string {
  if (!probe) return uiText.resourceDetail.dash;
  const handler = probe.httpGet
    ? `HTTP ${probe.httpGet.path ?? '/'}:${probe.httpGet.port}`
    : probe.tcpSocket
      ? `TCP :${probe.tcpSocket.port}`
      : probe.exec
        ? `Exec ${(probe.exec.command ?? []).join(' ')}`
        : uiText.resourceDetail.dash;
  return `${handler}; delay ${probe.initialDelaySeconds ?? 0}s; period ${probe.periodSeconds ?? 10}s`;
}

function windowMs(window: '1h' | '6h' | '24h'): number {
  if (window === '6h') return 6 * 60 * 60 * 1000;
  if (window === '24h') return 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function buildMetricPath(points: Array<{ at: number; value: number }>, kind: 'usage', maxValue?: number): string {
  if (points.length === 0) return '';
  const min = points[0].at;
  const max = points[points.length - 1].at || min + 1;
  const peak = maxValue ?? Math.max(...points.map((p) => p.value), 1);
  return points
    .map((point, index) => {
      const x = ((point.at - min) / Math.max(max - min, 1)) * 720;
      const y = 220 - (point.value / peak) * 180;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function formatMetricValue(value: number, metric: 'cpu' | 'memory'): string {
  if (value <= 0) return uiText.resourceDetail.dash;
  return metric === 'memory' ? formatBytes(value) : `${value.toFixed(0)}m`;
}

function formatChartTime(timestamp: number, window: '1h' | '6h' | '24h'): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(window === '24h' ? { weekday: 'short' as const } : {}),
  });
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
  if (!value) return uiText.resourceDetail.dash;
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
  const { canWrite } = usePermissions();
  const pushToast = useToast();

  const yamlQuery = useQuery({
    queryKey: ['yaml', plural, name, scope.namespace],
    queryFn: () => api.getResourceYaml(plural, name, scope),
  });

  const value = draft || yamlQuery.data?.yaml || '';

  const validate = useMutation({
    mutationFn: () => api.validateResourceYamlUpdate(plural, name, value, scope),
  });

  const save = useMutation({
    mutationFn: () => api.putResourceYaml(plural, name, value, scope),
    onSuccess: () => {
      pushToast('success', uiText.resourceDetail.savedSuccessfully);
      onSaved();
    },
    onError: (e) => pushToast('error', (e as Error).message),
  });

  return (
    <div className="drawer-body">
      <div className="actions-bar">
        {canWrite ? (
          <>
            <button className="primary" onClick={() => save.mutate()} disabled={save.isPending || yamlQuery.isLoading}>
              {`💾 ${uiText.common.save}`}
            </button>
            <ValidateYamlButton
              onValidate={() => validate.mutate()}
              isPending={validate.isPending}
              disabled={save.isPending || yamlQuery.isLoading}
            />
            <button onClick={() => { setDraft(''); yamlQuery.refetch(); validate.reset(); }}>{uiText.resourceDetail.revert}</button>
          </>
        ) : (
          <span className="dim">{uiText.resourceDetail.readOnlyNotice}</span>
        )}
      </div>
      {canWrite && (
        <div className="actions-bar" aria-live="polite">
          <YamlValidationNotice
            isError={validate.isError}
            errorMessage={validate.error instanceof Error ? validate.error.message : undefined}
            successMessage={
              validate.data
                ? uiText.resourceDetail.yamlValidUpdate(validate.data.kind, validate.data.name, validate.data.namespace)
                : undefined
            }
            idleMessage={uiText.resourceDetail.yamlValidateHint}
          />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="yaml"
          theme="vs-dark"
          value={value}
          onChange={(v) => { setDraft(v ?? ''); validate.reset(); }}
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

  if (reveal.isLoading) return <div className="empty">{uiText.resourceDetail.decoding}</div>;
  if (reveal.isError) return <div className="notice error">{(reveal.error as Error).message}</div>;

  return (
    <div style={{ padding: 14, overflow: 'auto' }}>
      <p className="dim">{uiText.resourceDetail.decodedValues}</p>
      <table>
        <thead>
          <tr>
            <th>{uiText.resourceDetail.keyColumn}</th>
            <th>{uiText.resourceDetail.value}</th>
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

type DataRow = { id: string; key: string; value: string };

let dataRowSeq = 0;
const nextRowId = () => `kv-${++dataRowSeq}`;

function ConfigLikeDetailsTab({
  kind,
  object,
  scope,
  isLoadingData,
  onChanged,
}: {
  kind: 'configmaps' | 'secrets';
  object: K8sObject;
  scope: Scope;
  isLoadingData: boolean;
  onChanged: () => void;
}) {
  const name = object.metadata?.name ?? '';
  const labels = object.metadata?.labels ?? {};
  const annotations = object.metadata?.annotations ?? {};
  const { canWrite } = usePermissions();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const pushToast = useToast();
  // Rows carry a stable id so editing a key does not remount its input and drop focus.
  const [draft, setDraft] = useState<DataRow[]>([]);
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  // Watch events hand us a new object identity constantly; never clobber unsaved edits.
  const dirtyRef = useRef(false);

  const eventsQuery = useQuery({
    queryKey: ['resource-events', kind, scope.context, scope.namespace, name],
    enabled: !!scope.context && !!scope.namespace && !!name,
    queryFn: () => api.listResource('events', scope),
  });

  const remoteData: Record<string, string> = (object as any).data ?? {};
  const remoteSignature = JSON.stringify(remoteData);

  useEffect(() => {
    if (dirtyRef.current) return;
    const next: DataRow[] = Object.entries(remoteData).map(([key, value]) => {
      const raw = String(value ?? '');
      if (kind !== 'secrets') return { id: nextRowId(), key, value: raw };
      try {
        return { id: nextRowId(), key, value: atob(raw) };
      } catch {
        return { id: nextRowId(), key, value: raw };
      }
    });
    setDraft(next);
    setOriginalKeys(next.map((row) => row.key));
    setVisibleSecrets({});
    // remoteData is derived from remoteSignature; depending on it would refire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, name, remoteSignature]);

  const toRecord = (rows: DataRow[]): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) record[key] = row.value;
    }
    return record;
  };

  const save = useMutation({
    mutationFn: () =>
      kind === 'secrets'
        ? api.putSecretData(name, toRecord(draft), scope)
        : api.putConfigMapData(name, toRecord(draft), scope),
    onSuccess: () => {
      dirtyRef.current = false;
      pushToast('success', uiText.resourceDetail.savedSuccessfully);
      void qc.invalidateQueries({ queryKey: ['resource-full', kind, name] });
      onChanged();
    },
    onError: (error) => pushToast('error', (error as Error).message),
  });

  const relatedEvents = (eventsQuery.data?.items ?? []).filter(
    (event) => ((event as any).involvedObject?.name as string | undefined) === name,
  );

  const setKey = (id: string, toKey: string) => {
    dirtyRef.current = true;
    setDraft((current) => current.map((row) => (row.id === id ? { ...row, key: toKey } : row)));
  };

  const setValue = (id: string, value: string) => {
    dirtyRef.current = true;
    setDraft((current) => current.map((row) => (row.id === id ? { ...row, value } : row)));
  };

  const removeKey = async (id: string, key: string) => {
    const ok = await confirm({
      title: uiText.confirmDialog.deleteTitle,
      message: uiText.resourceDetail.deleteKeyConfirm(key, kind === 'secrets' ? uiText.resourceDetail.secretKindLabel : uiText.resourceDetail.configMapKindLabel),
      details: uiText.resourceDetail.localChangeUntilSave,
    });
    if (!ok) return;

    dirtyRef.current = true;
    setDraft((current) => current.filter((row) => row.id !== id));
    setVisibleSecrets((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const addRow = () => {
    const base = 'new_key';
    let nextKey = base;
    let n = 1;
    while (draft.some((row) => row.key === nextKey)) {
      nextKey = `${base}_${n++}`;
    }
    const id = nextRowId();
    dirtyRef.current = true;
    setDraft((current) => [...current, { id, key: nextKey, value: '' }]);
    if (kind === 'secrets') {
      setVisibleSecrets((current) => ({ ...current, [id]: false }));
    }
  };

  const toggleSecretVisibility = (id: string) => {
    setVisibleSecrets((current) => ({ ...current, [id]: !current[id] }));
  };

  const encodedDisplay = (value: string) => {
    try {
      return btoa(value);
    } catch {
      return value;
    }
  };

  const handleSave = async () => {
    const currentKeys = new Set(draft.map((row) => row.key.trim()).filter(Boolean));
    const removedKeys = originalKeys.filter((key) => !currentKeys.has(key));
    if (removedKeys.length > 0) {
      const preview = removedKeys.slice(0, 5).join(', ');
      const more = removedKeys.length > 5 ? uiText.resourceDetail.andMoreSuffix(removedKeys.length - 5) : '';
      const ok = await confirm({
        title: uiText.confirmDialog.saveTitle,
        message: uiText.resourceDetail.removedKeysWarning(removedKeys.length, preview, more),
        details: uiText.resourceDetail.savingWillRemove,
        confirmLabel: uiText.confirmDialog.yesContinue,
      });
      if (!ok) return;
    }
    save.mutate();
  };

  return (
    <div className="drawer-body pod-overview">
      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.properties}</h4>
        </div>
        <div className="pod-properties-table">
          <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.created}</div><div className="pod-property-value">{formatCreated(object.metadata?.creationTimestamp)}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.name}</div><div className="pod-property-value">{name || uiText.resourceDetail.dash}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">{uiText.applications.namespace}</div><div className="pod-property-value">{object.metadata?.namespace ?? uiText.resourceDetail.dash}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.labels}</div><div className="pod-property-value">{uiText.resourceDetail.labelsCount(Object.keys(labels).length)}</div></div>
          <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.annotations}</div><div className="pod-property-value">{uiText.resourceDetail.annotationsCount(Object.keys(annotations).length)}</div></div>
          {kind === 'secrets' && <div className="pod-property-row"><div className="pod-property-label">{uiText.resourceDetail.type}</div><div className="pod-property-value">{(object as any).type ?? uiText.resourceDetail.dash}</div></div>}
        </div>
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.events}</h4>
        </div>
        {eventsQuery.isLoading && <div className="dim">{uiText.resourceDetail.loadingEvents}</div>}
        {!eventsQuery.isLoading && relatedEvents.length === 0 && <div className="dim">{uiText.resourceDetail.noEventsFound}</div>}
        {relatedEvents.length > 0 && (
          <div className="pod-properties-table">
            {relatedEvents.slice(0, 10).map((event: any, index) => (
              <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                <div className="pod-property-label">{event.reason ?? event.type ?? uiText.resourceDetail.eventReasonFallback}</div>
                <div className="pod-property-value">{event.message ?? uiText.resourceDetail.dash}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pod-section">
        <div className="pod-section-header">
          <h4>{uiText.resourceDetail.data}</h4>
          {canWrite && !isLoadingData && (
            <div className="metrics-toolbar">
              <button onClick={addRow}>{uiText.resourceDetail.addButton}</button>
              <button className="primary" onClick={handleSave} disabled={save.isPending}>{uiText.common.save}</button>
            </div>
          )}
        </div>
        {isLoadingData ? (
          <div className="dim">
            <span className="tiny-spinner" aria-label={uiText.resourceDetail.loadingData} /> {uiText.resourceDetail.loadingData}
          </div>
        ) : (
        <div className="kv-editor">
          {draft.length === 0 && <div className="dim">{uiText.resourceDetail.noDataEntries}</div>}
          {draft.map(({ id, key, value }) => (
            <div key={id} className="kv-editor-row">
              <input
                className="kv-key"
                value={key}
                onChange={(event) => setKey(id, event.target.value)}
                readOnly={!canWrite}
              />
              <textarea
                className="kv-value mono"
                value={kind === 'secrets' && !visibleSecrets[id] ? encodedDisplay(value) : value}
                onChange={(event) => setValue(id, event.target.value)}
                rows={2}
                readOnly={!canWrite || (kind === 'secrets' && !visibleSecrets[id])}
              />
              {kind === 'secrets' && (
                <button
                  className={`icon-action eye-toggle ${visibleSecrets[id] ? 'is-visible' : 'is-hidden'}`}
                  title={visibleSecrets[id] ? uiText.resourceDetail.hideSecretValue : uiText.resourceDetail.showSecretValue}
                  aria-label={visibleSecrets[id] ? uiText.resourceDetail.hideSecretValue : uiText.resourceDetail.showSecretValue}
                  onClick={() => toggleSecretVisibility(id)}
                >
                  👁
                </button>
              )}
              {canWrite && (
                <button
                  className={`icon-action ${kind === 'secrets' ? 'danger' : ''}`}
                  title={uiText.resourceDetail.deleteKey}
                  aria-label={uiText.resourceDetail.deleteKey}
                  onClick={() => void removeKey(id, key)}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
