import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { age, statusOf } from '../utils/format';
import { DataTable } from './DataTable';
import { NamespaceSelector } from './NamespaceSelector';

interface Props {
  scope: Scope;
  authRecoveryRefreshToken?: number;
  namespaces: string[];
  selectedNamespaces?: string[];
  onSelectedNamespacesChange: (next: string[]) => void;
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
}

type WorkloadPlural = 'deployments' | 'statefulsets' | 'daemonsets';

type ApplicationRow = {
  id: string;
  plural: WorkloadPlural;
  obj: K8sObject;
  instance: string;
  application: string;
  namespace: string;
  managedBy: string;
  version: string;
  createdAt?: string;
  status: string;
  statusTone: 'ok' | 'warn' | 'danger' | '';
};

export function ApplicationsPanel({
  scope,
  authRecoveryRefreshToken,
  namespaces,
  selectedNamespaces = [],
  onSelectedNamespacesChange,
  onAzureAuthRequired,
}: Props) {
  const authSourceFromError = (error: unknown): 'local' | 'cloud' | undefined => {
    if (!(error instanceof ApiError)) return undefined;
    const details = (error.details ?? null) as { code?: string; source?: string } | null;
    if (details?.code !== 'AZURE_AUTH_REQUIRED') return undefined;
    return details.source === 'local' ? 'local' : 'cloud';
  };

  const [query, setQuery] = useState('');
  const [, setAgeTick] = useState(0);
  const [detailsRow, setDetailsRow] = useState<ApplicationRow | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const queryKey = ['applications', scope.context, scope.namespace, ...selectedNamespaces];
  const applications = useQuery({
    queryKey,
    queryFn: async () => {
      const plurals: WorkloadPlural[] = ['deployments', 'statefulsets', 'daemonsets'];
      const results = await Promise.all(
        plurals.map(async (plural) => {
          const data = await api.listResource(plural, scope);
          return { plural, items: data.items };
        }),
      );

      const rows: ApplicationRow[] = [];
      for (const { plural, items } of results) {
        for (const obj of items) {
          const labels = obj.metadata?.labels ?? {};
          const name = obj.metadata?.name ?? '-';
          const namespace = obj.metadata?.namespace ?? '-';
          const instance = labels['app.kubernetes.io/instance'] || labels.release || name;
          const appName = labels['app.kubernetes.io/name'] || name;
          const managedBy = labels['app.kubernetes.io/managed-by'] || '-';
          const version = labels['app.kubernetes.io/version'] || '-';

          // k8sexplorer-style Applications is label-based; skip workloads without app labels.
          if (!labels['app.kubernetes.io/instance'] && !labels['app.kubernetes.io/name']) continue;

          const st = statusOf(plural, obj);
          rows.push({
            id: `${plural}:${namespace}/${name}`,
            plural,
            obj,
            instance,
            application: appName,
            namespace,
            managedBy,
            version,
            createdAt: obj.metadata?.creationTimestamp,
            status: st.text === 'Failed' ? 'Failed' : st.tone === 'ok' ? 'Running' : st.text || 'Unknown',
            statusTone: st.text === 'Failed' ? 'danger' : st.tone,
          });
        }
      }

      rows.sort((a, b) => {
        if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
        if (a.instance !== b.instance) return a.instance.localeCompare(b.instance);
        return a.application.localeCompare(b.application);
      });
      return { rows };
    },
    enabled: !!scope.context,
  });

  useEffect(() => {
    if (!(applications.error instanceof ApiError) || applications.error.status !== 401) return;
    onAzureAuthRequired?.(authSourceFromError(applications.error));
  }, [applications.error, onAzureAuthRequired]);

  useEffect(() => {
    if (!authRecoveryRefreshToken || !scope.context) return;
    void applications.refetch();
  }, [applications, authRecoveryRefreshToken, scope.context]);

  const items = useMemo(() => {
    const rows = applications.data?.rows ?? [];
    const namespaceFilter = selectedNamespaces.filter((value) => value.trim().length > 0);
    const namespaceFilterSet = new Set(namespaceFilter);

    const namespaceFiltered =
      namespaceFilterSet.size > 0 ? rows.filter((row) => namespaceFilterSet.has(row.namespace)) : rows;

    if (!query.trim()) return namespaceFiltered;
    const q = query.toLowerCase();
    return namespaceFiltered.filter((r) =>
      [r.instance, r.application, r.namespace, r.managedBy, r.version].some((v) => v.toLowerCase().includes(q)),
    );
  }, [applications.data?.rows, query, selectedNamespaces]);

  // All hooks must run before any early return (Rules of Hooks).
  if (!scope.context) return <div className="empty">Select a context to list applications.</div>;

  return (
    <>
      {/* <div className="toolbar">
        <h2>Applications</h2>
        <span className="dim">{items.length} items</span>
        {selectedCount > 0 && <span className="dim">{selectedCount} selected</span>}
        <div className="toolbar-actions">
          <button className="toolbar-refresh" onClick={() => applications.refetch()} title="Refresh">
            ⟳
          </button>
          <NamespaceSelector
            namespaces={namespaces}
            selectedNamespaces={selectedNamespaces}
            onChange={onSelectedNamespacesChange}
          />
        </div>
      </div> */}

      <div className="toolbar toolbar-compact-top">
        <input
          className="application-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Applications..."
        />
        <div className="toolbar-actions">
          {applications.isFetching && <span className="tiny-spinner" aria-label="refreshing applications" />}
          <NamespaceSelector
            namespaces={namespaces}
            selectedNamespaces={selectedNamespaces}
            onChange={onSelectedNamespacesChange}
          />
          <button className="toolbar-refresh" onClick={() => applications.refetch()} title="Refresh">
            ⟳
          </button>
        </div>
      </div>

      {applications.isError && <div className="notice error">{(applications.error as Error).message}</div>}
      {applications.isLoading && <div className="empty">Loading…</div>}
      {!applications.isLoading && items.length === 0 && <div className="empty">No applications found.</div>}

      {items.length > 0 && (
        <DataTable
          rows={items}
          rowKey={(row) => row.id}
          initialSortKey="instance"
          selectable
          onSelectionChange={(selectedRows) => setSelectedCount(selectedRows.length)}
          onShowDetails={(row) => setDetailsRow(row)}
          actions={[
            {
              label: 'Copy Instance',
              onClick: (row) => navigator.clipboard.writeText(row.instance).catch(() => undefined),
            },
          ]}
          columns={[
            { key: 'instance', header: 'Instance', value: (r) => r.instance, className: 'mono', width: 200 },
            { key: 'application', header: 'Application', value: (r) => r.application, className: 'mono', width: 180 },
            { key: 'namespace', header: 'Namespace', value: (r) => r.namespace, width: 140 },
            { key: 'managedBy', header: 'Managed By', value: (r) => r.managedBy, className: 'dim', width: 130 },
            { key: 'version', header: 'Version', value: (r) => r.version, className: 'dim', width: 110 },
            {
              key: 'age',
              header: 'Age',
              value: (r) => (r.createdAt ? new Date(r.createdAt).getTime() : 0),
              render: (r) => age(r.createdAt),
              className: 'dim',
              width: 90,
            },
            {
              key: 'status',
              header: 'Status',
              value: (r) => r.status,
              width: 120,
              render: (r) => (
                <span
                  className={`badge ${r.statusTone === 'danger' ? 'danger' : r.statusTone === 'ok' ? 'ok' : 'warn'}`}
                >
                  {r.status}
                </span>
              ),
            },
          ]}
        />
      )}

      {detailsRow && (
        <ApplicationDetailsDrawer row={detailsRow} scope={scope} onClose={() => setDetailsRow(null)} />
      )}
    </>
  );
}

function ApplicationDetailsDrawer({ row, scope, onClose }: { row: ApplicationRow; scope: Scope; onClose: () => void }) {
  const details = useQuery({
    queryKey: ['application-details', scope.context, row.id],
    enabled: !!scope.context,
    queryFn: async () => {
      const labels = row.obj.metadata?.labels ?? {};
      const selector = row.obj.spec?.selector?.matchLabels ?? {};

      const [podsRes, eventsRes] = await Promise.all([
        api.listResource('pods', { context: scope.context, namespace: row.namespace }),
        api.listResource('events', { context: scope.context, namespace: row.namespace }),
      ]);

      const pods = (podsRes.items ?? []).filter((pod) => {
        const podLabels = pod.metadata?.labels ?? {};
        const selectorMatched = Object.entries(selector).every(([key, value]) => podLabels[key] === String(value));
        if (selectorMatched) return true;

        const instance = labels['app.kubernetes.io/instance'];
        const appName = labels['app.kubernetes.io/name'];
        if (instance && podLabels['app.kubernetes.io/instance'] === instance) return true;
        if (appName && podLabels['app.kubernetes.io/name'] === appName) return true;
        return false;
      });

      const podTargets = pods.reduce<Array<{ name: string; namespace?: string }>>((acc, pod) => {
        const name = pod.metadata?.name;
        if (!name) return acc;
        acc.push({ name, namespace: pod.metadata?.namespace ?? row.namespace });
        return acc;
      }, []);
      const metricsBatch = await api.getPodMetricsBatch(podTargets, { context: scope.context, namespace: row.namespace });
      const metricsByPod = new Map(
        metricsBatch.items.map((item) => {
          const snapshot = item.snapshot;
          if (!snapshot) {
            return [item.name, undefined] as const;
          }
          const cpuMillicores = snapshot.containers.reduce((sum, c) => sum + c.cpuMillicores, 0);
          const memoryBytes = snapshot.containers.reduce((sum, c) => sum + c.memoryBytes, 0);
          return [item.name, { cpuMillicores, memoryBytes }] as const;
        }),
      );

      const podNames = new Set(pods.map((pod) => pod.metadata?.name).filter(Boolean));
      const events = (eventsRes.items ?? [])
        .filter((event) => {
          const involved = (event as any).involvedObject;
          return involved?.name === row.obj.metadata?.name || podNames.has(involved?.name);
        })
        .sort((a, b) => {
          const aTs = new Date((a.lastTimestamp ?? a.eventTime ?? a.metadata?.creationTimestamp ?? '') as string).getTime();
          const bTs = new Date((b.lastTimestamp ?? b.eventTime ?? b.metadata?.creationTimestamp ?? '') as string).getTime();
          return bTs - aTs;
        });

      return { pods, events, metricsByPod };
    },
  });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer app-details-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <span className="badge">Application</span>
          <h3>{`ApplicationInstance: ${row.instance}`}</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body pod-overview">
          <div className="app-details-grid">
        <section className="app-details-section">
          <h4>Metrics</h4>
          <div className="dim">Displaying metrics from Kubernetes Metrics Server</div>
          <div className="app-metrics-box">
            <div>CPU Usage</div>
            <strong>
              {details.data
                ? `${Array.from(details.data.metricsByPod.values()).reduce((sum, metric) => sum + (metric?.cpuMillicores ?? 0), 0).toFixed(0)}m`
                : '-'}
            </strong>
          </div>
        </section>

        <section className="app-details-section">
          <h4>Properties</h4>
          <div className="app-props-table">
            <div className="app-props-row"><span>Created</span><span>{age(row.createdAt)}</span></div>
            <div className="app-props-row"><span>Status</span><span className={row.status === 'Running' ? 'status-running' : ''}>{row.status}</span></div>
            <div className="app-props-row"><span>Application</span><span>{row.application}</span></div>
            <div className="app-props-row"><span>Version</span><span>{row.version}</span></div>
            <div className="app-props-row"><span>Managed By</span><span>{row.managedBy}</span></div>
            <div className="app-props-row"><span>Name</span><span>{row.obj.metadata?.name ?? '-'}</span></div>
            <div className="app-props-row"><span>Namespace</span><span>{row.namespace}</span></div>
          </div>
        </section>

        <section className="app-details-section">
          <h4>Pods</h4>
          {details.isLoading && <div className="dim">Loading pods…</div>}
          {!details.isLoading && (details.data?.pods.length ?? 0) === 0 && <div className="dim">No pods found</div>}
          {(details.data?.pods.length ?? 0) > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Node</th>
                  <th>Namespace</th>
                  <th>Ready</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {details.data?.pods.map((pod) => {
                  const statuses = Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : [];
                  const readyCount = statuses.filter((status: any) => status.ready).length;
                  const total = statuses.length;
                  const metric = details.data?.metricsByPod.get(pod.metadata?.name ?? '');
                  return (
                    <tr key={pod.metadata?.uid ?? pod.metadata?.name}>
                      <td className="mono">{pod.metadata?.name}</td>
                      <td>{pod.spec?.nodeName ?? '-'}</td>
                      <td>{pod.metadata?.namespace ?? '-'}</td>
                      <td>{total > 0 ? `${readyCount}/${total}` : '-'}</td>
                      <td>{metric ? `${metric.cpuMillicores.toFixed(0)}m` : '-'}</td>
                      <td>{metric ? formatBytes(metric.memoryBytes) : '-'}</td>
                      <td>
                        <span className={`badge ${statusOf('pods', pod).tone}`}>{statusOf('pods', pod).text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="app-details-section">
          <h4>Workload Resources</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Component</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{row.obj.metadata?.name ?? '-'}</td>
                <td>{row.obj.kind ?? row.plural.slice(0, -1)}</td>
                <td>{row.application}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="app-details-section">
          <h4>Vulnerabilities</h4>
          <div className="dim">Images</div>
          <div className="security-placeholder">Unknown</div>
        </section>

        <section className="app-details-section">
          <h4>Events</h4>
          {details.isLoading && <div className="dim">Loading events…</div>}
          {!details.isLoading && (details.data?.events.length ?? 0) === 0 && <div className="dim">No events found</div>}
          {(details.data?.events.length ?? 0) > 0 && (
            <div className="pod-properties-table">
              {details.data?.events.slice(0, 20).map((event: any, index: number) => (
                <div key={`${event.metadata?.uid ?? index}`} className="pod-property-row">
                  <div className="pod-property-label">{event.reason ?? event.type ?? 'Event'}</div>
                  <div className="pod-property-value">{event.message ?? '-'}</div>
                </div>
              ))}
            </div>
          )}
        </section>
          </div>
      </div>
      </div>
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)}${units[unit]}`;
}
