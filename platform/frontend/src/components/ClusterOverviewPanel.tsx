import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { HelmRelease, K8sObject } from '../api/types';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { uiText } from '../text';
import { NamespaceSelector } from './NamespaceSelector';

type OverviewKind = 'pods' | 'deployments' | 'replicasets' | 'cronjobs' | 'daemonsets' | 'statefulsets' | 'jobs' | 'helmreleases';
type MetricSample = { at: number; cpuMillicores: number; memoryBytes: number };
type OverviewBadge = { label: string; tone: 'ok' | 'warn' | 'danger' };

const OVERVIEW_KINDS: Array<{ key: OverviewKind; label: string }> = [
  { key: 'pods', label: uiText.applications.pods },
  { key: 'deployments', label: uiText.applications.deployments },
  { key: 'replicasets', label: uiText.applications.replicaSets },
  { key: 'cronjobs', label: uiText.applications.cronJobs },
  { key: 'daemonsets', label: uiText.applications.daemonSets },
  { key: 'statefulsets', label: uiText.applications.statefulSets },
  { key: 'jobs', label: uiText.applications.jobs },
  { key: 'helmreleases', label: uiText.applications.helmReleases },
];

interface Props {
  scope: Scope;
  namespaces: string[];
  selectedNamespaces: string[];
  onSelectedNamespacesChange: (next: string[]) => void;
  onOpenResource: (plural: string) => void;
  onOpenHelmReleases: () => void;
  onOpenEvents: () => void;
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
}

export function ClusterOverviewPanel ({ scope, namespaces, selectedNamespaces, onSelectedNamespacesChange, onOpenResource, onOpenHelmReleases, onOpenEvents, onAzureAuthRequired }: Props) {
  const [metricHistory, setMetricHistory] = useState<MetricSample[]>([]);
  const clusterScope = { ...scope, namespace: undefined };
  const overview = useQuery({
    queryKey: ['cluster-overview', scope.context, scope.source, ...selectedNamespaces],
    enabled: !!scope.context,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const queryScopes = selectedNamespaces.length > 0
        ? selectedNamespaces.map((namespace) => ({ ...scope, namespace }))
        : [clusterScope];
      const compact = await api.clusterOverview(scope, selectedNamespaces);
      const helmResults = await Promise.all(queryScopes.map((queryScope) => api.helmReleases(queryScope)));
      return {
        resources: compact.resources,
        helmReleases: helmResults.flatMap((result) => result.releases),
        nodes: compact.nodes,
        nodesForbidden: compact.nodesForbidden,
        metrics: compact.metrics,
        events: compact.events,
      };
    },
  });

  useAzureAuthRequiredEffect(overview.error, onAzureAuthRequired);

  const counts = useMemo<Record<OverviewKind, number>>(() => {
    const result = {} as Record<OverviewKind, number>;
    const namespaceFilter = new Set(selectedNamespaces);
    const namespaceVisible = (namespace?: string) => namespaceFilter.size === 0 || (!!namespace && namespaceFilter.has(namespace));
    for (const { key } of OVERVIEW_KINDS) {
      if (key === 'helmreleases') continue;
      result[key] = (overview.data?.resources[key] ?? []).filter((resource) => namespaceVisible(resource.metadata?.namespace)).length;
    }
    result.helmreleases = (overview.data?.helmReleases ?? []).filter((release) => namespaceVisible(release.namespace)).length;
    return result;
  }, [overview.data, selectedNamespaces]);

  const badges = useMemo<Record<OverviewKind, OverviewBadge>>(() => {
    const namespaceFilter = new Set(selectedNamespaces);
    const visible = (namespace?: string) => namespaceFilter.size === 0 || (!!namespace && namespaceFilter.has(namespace));
    const resources = (key: OverviewKind) => (overview.data?.resources[key] ?? []).filter((resource) => visible(resource.metadata?.namespace));
    const podResources = resources('pods');
    const deploymentResources = resources('deployments');
    const helmStatuses = (overview.data?.helmReleases ?? []).filter((release) => visible(release.namespace)).map((release) => release.status);
    const allReady = (items: K8sObject[]) => items.length > 0 && items.every((item) => {
      const desired = item.spec?.replicas ?? 0;
      return (item.status?.readyReplicas ?? 0) === desired && (item.status?.availableReplicas ?? 0) === desired;
    });
    const podHealthy = podResources.length > 0 && podResources.every((pod) => isHealthyPod(pod));
    const active = (items: K8sObject[]) => items.some((item) => (item.spec?.suspend !== true) && (item.status?.active ?? item.status?.replicas ?? item.spec?.replicas ?? 0) > 0);
    const cronJobs = resources('cronjobs');
    const daemonSets = resources('daemonsets');
    const statefulSets = resources('statefulsets');
    const jobs = resources('jobs');
    const replicaSets = resources('replicasets');
    return {
      pods: { label: podHealthy ? 'Healthy' : podResources.length ? 'Attention' : 'No pods', tone: podHealthy ? 'ok' : podResources.length ? 'warn' : 'warn' },
      deployments: { label: allReady(deploymentResources) ? 'Healthy' : deploymentResources.length ? 'Updating' : 'No deployments', tone: allReady(deploymentResources) ? 'ok' : 'warn' },
      replicasets: { label: replicaSets.length === 0 ? 'No replica sets' : active(replicaSets) ? 'Active' : 'Idle', tone: active(replicaSets) ? 'ok' : 'warn' },
      cronjobs: { label: cronJobs.length === 0 ? 'No cron jobs' : cronJobs.some((job) => job.spec?.suspend !== true) ? 'Active' : 'Idle', tone: cronJobs.some((job) => job.spec?.suspend !== true) ? 'ok' : 'warn' },
      daemonsets: { label: daemonSets.length === 0 ? 'No daemon sets' : allReady(daemonSets) ? 'Healthy' : 'Updating', tone: allReady(daemonSets) ? 'ok' : 'warn' },
      statefulsets: { label: statefulSets.length === 0 ? 'No stateful sets' : allReady(statefulSets) ? 'Healthy' : 'Updating', tone: allReady(statefulSets) ? 'ok' : 'warn' },
      jobs: { label: jobs.length === 0 ? 'No jobs' : active(jobs) ? 'Active' : 'Complete', tone: active(jobs) ? 'ok' : 'warn' },
      helmreleases: { label: helmStatuses.length > 0 && helmStatuses.every((status) => status === 'deployed') ? 'Healthy' : helmStatuses.length ? 'Attention' : 'No releases', tone: helmStatuses.length > 0 && helmStatuses.every((status) => status === 'deployed') ? 'ok' : 'warn' },
    };
  }, [overview.data, selectedNamespaces]);

  const tileResources = useMemo(() => {
    const namespaceFilter = new Set(selectedNamespaces);
    const visible = (namespace?: string) => namespaceFilter.size === 0 || (!!namespace && namespaceFilter.has(namespace));
    const resources = {} as Record<OverviewKind, K8sObject[]>;
    for (const { key } of OVERVIEW_KINDS) {
      resources[key] = (overview.data?.resources[key] ?? []).filter((resource) => visible(resource.metadata?.namespace));
    }
    return {
      resources,
      helmReleases: (overview.data?.helmReleases ?? []).filter((release) => visible(release.namespace)),
    };
  }, [overview.data, selectedNamespaces]);

  useEffect(() => {
    const sample = overview.data?.metrics;
    if (!sample) return;
    setMetricHistory((current) => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return [...current.filter((entry) => entry.at >= cutoff && entry.at !== sample.at), sample].slice(-5760);
    });
  }, [overview.data?.metrics]);

  const podStatus = useMemo(() => {
    const pods = overview.data?.resources.pods ?? [];
    return pods.reduce((counts, pod) => {
      const phase = pod.status?.phase ?? 'Unknown';
      counts[phase] = (counts[phase] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
  }, [overview.data?.resources.pods]);
  const totalPods = Object.values(podStatus).reduce((sum, value) => sum + value, 0);
  const nodeStatus = useMemo(() => {
    const nodes = overview.data?.nodes ?? [];
    return nodes.reduce((counts, node) => {
      const ready = Array.isArray(node.status?.conditions)
        && node.status.conditions.some((condition: any) => condition.type === 'Ready' && condition.status === 'True');
      const status = ready ? 'Ready' : node.metadata?.deletionTimestamp ? 'Draining' : 'NotReady';
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
  }, [overview.data?.nodes]);
  const totalNodes = Object.values(nodeStatus).reduce((sum, value) => sum + value, 0);
  const readyNodes = nodeStatus.Ready ?? 0;
  const nodesForbidden = overview.data?.nodesForbidden ?? false;
  const totalCpu = overview.data?.metrics.cpuMillicores ?? 0;
  const totalMemory = overview.data?.metrics.memoryBytes ?? 0;
  const podResources = aggregatePodResources(overview.data?.resources.pods ?? []);
  const cpuScale = podResources.cpuLimit || podResources.cpuRequest || Math.max(...metricHistory.map((sample) => sample.cpuMillicores), totalCpu, 1);
  const memoryScale = podResources.memoryLimit || podResources.memoryRequest || Math.max(...metricHistory.map((sample) => sample.memoryBytes), totalMemory, 1);
  const cpuPercent = Math.min(100, (totalCpu / cpuScale) * 100);
  const memoryPercent = Math.min(100, (totalMemory / memoryScale) * 100);
  const cpuPoints = metricHistory.map((sample) => ({ at: sample.at, value: Math.min(100, (sample.cpuMillicores / cpuScale) * 100) }));
  const memoryPoints = metricHistory.map((sample) => ({ at: sample.at, value: Math.min(100, (sample.memoryBytes / memoryScale) * 100) }));

  if (!scope.context) return <div className="empty">{uiText.applications.selectContextForOverview}</div>;

  return (
    <>
      <div className="toolbar">
        <h2>{uiText.applications.clusterOverview}</h2>
        <span className="dim">{uiText.applications.clusterOverviewDescription}</span>
        <div className="toolbar-actions">
          {overview.isFetching && <span className="tiny-spinner" aria-label={uiText.applications.loadingOverview} />}
          <NamespaceSelector
            namespaces={namespaces}
            selectedNamespaces={selectedNamespaces}
            onChange={onSelectedNamespacesChange}
          />
          <button className="toolbar-refresh" onClick={() => overview.refetch()} title={uiText.common.refresh}>⟳</button>
        </div>
      </div>
      <section className="cluster-overview-content">
        {overview.isError && <div className="notice error">{(overview.error as Error).message}</div>}
        <div className="applications-overview-counts">
          {OVERVIEW_KINDS.map(({ key, label }) => (
            <button
              key={key}
              className="applications-overview-count"
              onClick={() => key === 'helmreleases' ? onOpenHelmReleases() : onOpenResource(key)}
            >
              <span>{label}</span>
              <strong>{counts[key] ?? 0}</strong>
              <span className={`overview-tile-badge ${badges[key].tone}`}><i />{badges[key].label}</span>
              <OverviewTileGraphic kind={key} resources={tileResources.resources[key]} helmReleases={tileResources.helmReleases} />
            </button>
          ))}
        </div>
        <div className="cluster-overview-dashboard">
          <div className="cluster-overview-card cluster-metric-card">
            <div className="cluster-card-heading"><h3>{uiText.applications.cpuUsage}</h3><strong>{cpuPercent.toFixed(0)}% <small>{totalCpu.toFixed(0)}m</small></strong></div>
            <OverviewMetricChart points={cpuPoints} color="cpu" rawValue={(value) => `${value.toFixed(0)}m`} />
          </div>
          <div className="cluster-overview-card cluster-metric-card">
            <div className="cluster-card-heading"><h3>{uiText.applications.memoryUsage}</h3><strong>{memoryPercent.toFixed(0)}% <small>{formatBytes(totalMemory)}</small></strong></div>
            <OverviewMetricChart points={memoryPoints} color="memory" rawValue={formatBytes} />
          </div>
          <div className="cluster-overview-card cluster-status-card">
            <div className="cluster-card-heading"><h3>{uiText.applications.nodeStatus}</h3>{!nodesForbidden && <strong>{readyNodes}/{totalNodes}</strong>}</div>
            {nodesForbidden ? (
              <div className="cluster-access-denied"><strong>{uiText.applications.accessRestricted}</strong><span>{uiText.applications.nodesForbidden}</span></div>
            ) : (
              <div className="cluster-status-layout">
                <div className="cluster-status-donut" style={{ background: podStatusGradient(nodeStatus, totalNodes) }}><strong>{readyNodes}</strong><span>{uiText.applications.ready}</span></div>
                <div className="cluster-status-legend">
                  {Object.entries(nodeStatus).map(([status, count]) => <span key={status}><i className={`status-dot ${status.toLowerCase()}`} />{status} {count}</span>)}
                </div>
              </div>
            )}
          </div>
          {/* <div className="cluster-overview-card cluster-status-card">
            <div className="cluster-card-heading"><h3>{uiText.applications.podStatus}</h3><strong>{totalPods} {uiText.applications.pods}</strong></div>
            <div className="cluster-status-layout">
              <div className="cluster-status-donut" style={{ background: podStatusGradient(podStatus, totalPods) }}><strong>{totalPods}</strong><span>{uiText.applications.pods}</span></div>
              <div className="cluster-status-legend">
                {Object.entries(podStatus).map(([status, count]) => <span key={status}><i className={`status-dot ${status.toLowerCase()}`} />{status} {count}</span>)}
              </div>
            </div>
          </div> */}
        </div>
        <div className="cluster-overview-card cluster-events-card">
          <div className="cluster-card-heading"><h3>{uiText.applications.recentEvents}</h3><button className="cluster-events-link" onClick={onOpenEvents}>{uiText.applications.showAllEvents} →</button></div>
          <div className="cluster-events-list">
            {(overview.data?.events ?? []).slice(0, 6).map((event: any, index) => (
              <div className="cluster-event-row" key={`${event.metadata?.uid ?? index}`}>
                <span className={`event-badge ${String(event.type ?? 'Normal').toLowerCase()}`}>{event.type ?? 'Normal'}</span>
                <strong>{event.reason ?? uiText.resourceDetail.eventReasonFallback}</strong>
                <span className="cluster-event-message">{event.message ?? uiText.resourceDetail.dash}</span>
                <span className="cluster-event-target">{formatEventTarget(event)}</span>
                <span className="dim">{formatEventTime(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)}</span>
              </div>
            ))}
            {overview.data && (overview.data.events ?? []).length === 0 && <div className="dim">{uiText.resourceDetail.noEventsFound}</div>}
          </div>
        </div>
      </section>
    </>
  );
}

function OverviewTileGraphic ({ kind, resources, helmReleases }: { kind: OverviewKind; resources: K8sObject[]; helmReleases: HelmRelease[] }) {
  if (false && kind === "pods") {
    const summary = summarizePods(resources);
    const ratio = summary.total > 0 ? summary.healthy / summary.total : 0;
    const circumference = 2 * Math.PI * 20;
    const healthyLength = circumference * (summary.healthy / Math.max(summary.total, 1));
    const startingLength = circumference * (summary.starting / Math.max(summary.total, 1));
    const terminatingLength = circumference * (summary.terminating / Math.max(summary.total, 1));
    return (
      <>
        <span className="overview-tile-graphic overview-pod-graphic" aria-label={`${summary.healthy} healthy, ${summary.starting} starting, ${summary.terminating} terminating`}>
          <svg viewBox="0 0 48 48">
            <circle className="overview-tile-ring-track" cx="24" cy="24" r="20" />
            {healthyLength > 0 && <circle className="overview-pod-segment healthy" cx="24" cy="24" r="20" strokeDasharray={`${healthyLength} ${circumference - healthyLength}`} />}
            {startingLength > 0 && <circle className="overview-pod-segment starting" cx="24" cy="24" r="20" strokeDasharray={`${startingLength} ${circumference - startingLength}`} strokeDashoffset={-healthyLength} />}
            {terminatingLength > 0 && <circle className="overview-pod-segment terminating" cx="24" cy="24" r="20" strokeDasharray={`${terminatingLength} ${circumference - terminatingLength}`} strokeDashoffset={-(healthyLength + startingLength)} />}
          </svg>
          <span>{Math.round(ratio * 100)}%</span>
        </span>
        <span className="overview-pod-breakdown">
          <span className="healthy"><i />Healthy {summary.healthy}</span>
          <span className="starting"><i />Starting {summary.starting}</span>
          <span className="terminating"><i />Terminating {summary.terminating}</span>
        </span>
      </>
    );
  }
  const { complete, total } = tileCompletion(kind, resources, helmReleases);
  const ratio = total > 0 ? Math.max(0, Math.min(1, complete / total)) : 0;
  const circumference = 2 * Math.PI * 22;
  const dash = circumference * ratio;
  const tone = ratio >= 0.9 ? 'ok' : ratio > 0 ? 'warn' : 'zero';

  return (
    <span className={`overview-tile-graphic ${tone}`} aria-hidden="true">
      <svg viewBox="0 0 48 48">
        <circle className="overview-tile-ring-track" cx="24" cy="24" r="20" />
        <circle
          className="overview-tile-ring-value"
          cx="24"
          cy="24"
          r="20"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 24 24)"
        />
      </svg>
      <span>{`${Math.round(ratio * 100)}%`}</span>
    </span>
  );
}

function summarizePods (resources: K8sObject[]): { healthy: number; starting: number; terminating: number; total: number } {
  return resources.reduce<{ healthy: number; starting: number; terminating: number; total: number }>((summary, pod) => {
    if (pod.metadata?.deletionTimestamp) summary.terminating += 1;
    else if (isHealthyPod(pod)) summary.healthy += 1;
    else summary.starting += 1;
    summary.total += 1;
    return summary;
  }, { healthy: 0, starting: 0, terminating: 0, total: 0 });
}

function tileCompletion (kind: OverviewKind, resources: K8sObject[], helmReleases: HelmRelease[]): { complete: number; total: number } {
  if (kind === 'helmreleases') {
    return { complete: helmReleases.filter((release) => release.status === 'deployed').length, total: helmReleases.length };
  }
  if (kind === 'pods') {
    return { complete: resources.filter((pod) => isHealthyPod(pod)).length, total: resources.length };
  }
  if (kind === 'jobs') {
    return {
      complete: resources.filter((job) => (job.status?.succeeded ?? 0) > 0 || (job.status?.active ?? 0) > 0).length,
      total: resources.length,
    };
  }
  if (kind === 'cronjobs') {
    return { complete: resources.filter((job) => job.spec?.suspend !== true).length, total: resources.length };
  }
  if (kind === 'daemonsets') {
    return {
      complete: resources.reduce((sum, resource) => sum + Math.min(
        resource.status?.numberReady ?? resource.status?.numberAvailable ?? resource.status?.currentNumberScheduled ?? 0,
        resource.status?.desiredNumberScheduled ?? resource.status?.numberScheduled ?? 1,
      ), 0),
      total: resources.reduce((sum, resource) => sum + (resource.status?.desiredNumberScheduled ?? resource.status?.numberScheduled ?? 1), 0),
    };
  }
  return resources.reduce<{ complete: number; total: number }>((result, resource) => {
    const desired = resource.spec?.replicas ?? resource.status?.replicas ?? resource.status?.currentReplicas ?? 1;
    const ready = resource.status?.readyReplicas ?? resource.status?.availableReplicas ?? resource.status?.currentReplicas ?? 0;
    result.complete += Math.min(ready, desired);
    result.total += desired;
    return result;
  }, { complete: 0, total: 0 });
}

function isHealthyPod (pod: K8sObject): boolean {
  const phase = String(pod.status?.phase ?? '').toLowerCase();
  return phase === 'running' || phase === 'succeeded' || pod.status?.ready === true;
}

function formatBytes (value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} Gi`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} Mi`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} Ki`;
  return `${value.toFixed(0)} B`;
}

function formatEventTime (value?: string): string {
  if (!value) return uiText.resourceDetail.dash;
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function podStatusGradient (statuses: Record<string, number>, total: number): string {
  if (!total) return 'conic-gradient(var(--surface-control) 0 100%)';
  const colors: Record<string, string> = { running: 'var(--ok)', pending: 'var(--accent)', failed: 'var(--danger)', succeeded: 'var(--ok-line)', unknown: 'var(--text-dim)' };
  let position = 0;
  const stops = Object.entries(statuses).map(([status, count]) => {
    const start = position;
    position += (count / total) * 100;
    return `${colors[status.toLowerCase()] ?? 'var(--text-dim)'} ${start}% ${position}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function OverviewMetricChart ({ points, color, rawValue }: { points: Array<{ at: number; value: number }>; color: 'cpu' | 'memory'; rawValue: (value: number) => string }) {
  const visible = points.slice(-48);
  const path = buildOverviewLinePath(visible);
  const area = path ? `${path} L 700 112 L 28 112 Z` : '';
  const first = visible[0]?.at ?? Date.now();
  const last = visible[visible.length - 1]?.at ?? first;
  const middle = first + (last - first) / 2;
  return (
    <div className="cluster-line-chart">
      <div className="cluster-y-axis"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
      <div className="cluster-chart-frame">
        <svg viewBox="0 0 728 128" preserveAspectRatio="none">
          {[8, 34, 60, 86, 112].map((y) => <line key={y} x1="28" y1={y} x2="700" y2={y} className="cluster-chart-grid-line" />)}
          {area && <path d={area} className={`cluster-chart-area ${color}`} />}
          {path && <path d={path} className={`cluster-chart-line ${color}`} />}
          {visible.map((point) => <circle key={point.at} cx={28 + ((point.at - first) / Math.max(last - first, 1)) * 672} cy={112 - (point.value / 100) * 104} r="1.8" className={`cluster-chart-point ${color}`}><title>{`${formatChartTime(point.at)}: ${point.value.toFixed(0)}% (${rawValue(point.value)})`}</title></circle>)}
        </svg>
        <div className="cluster-x-axis"><span>{formatChartTime(first)}</span><span>{formatChartTime(middle)}</span><span>{formatChartTime(last)}</span></div>
      </div>
    </div>
  );
}

function buildOverviewLinePath (points: Array<{ at: number; value: number }>): string {
  if (!points.length) return '';
  const first = points[0].at;
  const last = points[points.length - 1].at;
  return points.map((point, index) => {
    const x = 28 + ((point.at - first) / Math.max(last - first, 1)) * 672;
    const y = 112 - (point.value / 100) * 104;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function formatChartTime (timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function aggregatePodResources (pods: K8sObject[]): { cpuRequest: number; cpuLimit: number; memoryRequest: number; memoryLimit: number } {
  return pods.reduce<{ cpuRequest: number; cpuLimit: number; memoryRequest: number; memoryLimit: number }>((totals, pod) => {
    const containers = Array.isArray(pod.spec?.containers) ? pod.spec.containers : [];
    for (const container of containers) {
      totals.cpuRequest += parseCpu(container.resources?.requests?.cpu);
      totals.cpuLimit += parseCpu(container.resources?.limits?.cpu);
      totals.memoryRequest += parseMemory(container.resources?.requests?.memory);
      totals.memoryLimit += parseMemory(container.resources?.limits?.memory);
    }
    return totals;
  }, { cpuRequest: 0, cpuLimit: 0, memoryRequest: 0, memoryLimit: 0 });
}

function parseCpu (value?: string): number {
  if (!value) return 0;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1000;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  return Number(value) * 1000;
}

function parseMemory (value?: string): number {
  if (!value) return 0;
  const match = /^([\d.]+)(Ki|Mi|Gi|Ti)?$/.exec(value);
  if (!match) return Number(value) || 0;
  const factors: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return Number(match[1]) * (factors[match[2] ?? ''] ?? 1);
}

function formatEventTarget (event: any): string {
  const target = event.involvedObject ?? event.regarding;
  if (!target?.name) return uiText.resourceDetail.dash;
  return `${target.kind ?? 'Resource'}/${target.name}`;
}

