import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { HelmRelease } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { Modal } from './Modal';
import { DataTable } from './DataTable';
import { DetailsModal } from './DetailsModal';
import { NamespaceSelector } from './NamespaceSelector';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { HelmInstallModal } from './HelmInstallModal';
import { HelmUpgradeModal } from './HelmUpgradeModal';

type DetailsState = { title: string; rows: Array<[string, string | number | undefined]> } | null;

interface Props {
  scope: Scope;
  mode: 'releases' | 'charts';
  authRecoveryRefreshToken?: number;
  namespaces: string[];
  selectedNamespaces?: string[];
  onSelectedNamespacesChange: (next: string[]) => void;
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
  onToast?: (tone: 'success' | 'error' | 'info', text: string) => void;
}

export function HelmPanel({
  scope,
  mode,
  authRecoveryRefreshToken,
  namespaces,
  selectedNamespaces = [],
  onSelectedNamespacesChange,
  onAzureAuthRequired,
  onToast,
}: Props) {
  const qc = useQueryClient();
  const { canWrite, canDelete } = usePermissions();
  const [historyFor, setHistoryFor] = useState<HelmRelease | null>(null);
  const [valuesFor, setValuesFor] = useState<HelmRelease | null>(null);
  const [upgradeFor, setUpgradeFor] = useState<HelmRelease | null>(null);
  const [details, setDetails] = useState<DetailsState>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);
  // Charts page: off => charts deployed in the selected namespace(s);
  // on => full installable catalog from the configured Helm repos.
  const [showCatalog, setShowCatalog] = useState(false);

  const queryKey = ['helm', scope.context, scope.namespace, ...selectedNamespaces];
  const releases = useQuery({
    queryKey,
    queryFn: () => api.helmReleases(scope),
    enabled: !!scope.context,
  });

  const visibleReleases = useMemo(() => {
    const rows = releases.data?.releases ?? [];
    const namespaceFilter = selectedNamespaces.filter((value) => value.trim().length > 0);
    if (namespaceFilter.length === 0) return rows;
    const namespaceFilterSet = new Set(namespaceFilter);
    return rows.filter((row) => namespaceFilterSet.has(row.namespace));
  }, [releases.data?.releases, selectedNamespaces]);

  // Distinct charts in use, derived from the releases visible for this namespace.
  const usedCharts = useMemo(() => {
    const map = new Map<
      string,
      { chart: string; name: string; version: string; appVersion?: string; releases: number; namespaces: Set<string> }
    >();
    for (const r of visibleReleases) {
      const chart = r.chart ?? '';
      if (!chart) continue;
      const match = /^(.*)-(v?\d[\w.+-]*)$/.exec(chart);
      const entry =
        map.get(chart) ??
        {
          chart,
          name: match ? match[1] : chart,
          version: match ? match[2] : '',
          appVersion: r.app_version,
          releases: 0,
          namespaces: new Set<string>(),
        };
      entry.releases += 1;
      if (r.namespace) entry.namespaces.add(r.namespace);
      map.set(chart, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleReleases]);

  const charts = useQuery({
    queryKey: ['helm-charts'],
    queryFn: () => api.helmCharts(),
    enabled: mode === 'charts' && showCatalog,
  });

  const activeError = mode === 'charts' && showCatalog ? charts.error : releases.error;
  useAzureAuthRequiredEffect(activeError, onAzureAuthRequired);

  useEffect(() => {
    if (!authRecoveryRefreshToken || !scope.context) return;
    if (mode === 'charts' && showCatalog) {
      void charts.refetch();
      return;
    }
    void releases.refetch();
  }, [authRecoveryRefreshToken, charts, mode, releases, scope.context, showCatalog]);

  const uninstall = useMutation({
    mutationFn: (r: HelmRelease) => api.helmUninstall(r.name, { context: scope.context, namespace: r.namespace }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  if (!scope.context) return <div className="empty">Select a context to list Helm releases.</div>;

  return (
    <>
      <div className="toolbar">
        <h2>{mode === 'releases' ? 'Helm Releases' : 'Helm Charts'}</h2>
        <span className="dim">
          {mode === 'releases'
            ? `${visibleReleases.length} releases`
            : `${showCatalog ? charts.data?.charts.length ?? 0 : usedCharts.length} charts`}
        </span>
        {mode === 'charts' && (
          <label className="helm-catalog-toggle" title="Show all installable charts from your Helm repositories">
            <input type="checkbox" checked={showCatalog} onChange={(e) => setShowCatalog(e.target.checked)} />
            <span>Repo catalog</span>
          </label>
        )}
        <div className="toolbar-actions">
          {(releases.isFetching || charts.isFetching) && (
            <span className="tiny-spinner" aria-label="refreshing helm resources" />
          )}
          <NamespaceSelector
            namespaces={namespaces}
            selectedNamespaces={selectedNamespaces}
            onChange={onSelectedNamespacesChange}
          />
          {mode === 'releases' && canWrite && (
            <button
              className="toolbar-action-button"
              onClick={() => setShowInstallModal(true)}
              title="Install a new Helm release"
            >
              + Install
            </button>
          )}
          <button
            className="toolbar-refresh"
            onClick={() => (mode === 'charts' && showCatalog ? charts.refetch() : releases.refetch())}
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      </div>

      {mode === 'releases' && releases.isError && <div className="notice error">{(releases.error as Error).message}</div>}
      {mode === 'charts' && showCatalog && charts.isError && (
        <div className="notice error">{(charts.error as Error).message}</div>
      )}
      {mode === 'charts' && !showCatalog && releases.isError && (
        <div className="notice error">{(releases.error as Error).message}</div>
      )}
      {mode === 'releases' && releases.isLoading && <div className="empty">Loading…</div>}
      {mode === 'charts' && showCatalog && charts.isLoading && <div className="empty">Loading…</div>}
      {mode === 'charts' && !showCatalog && releases.isLoading && <div className="empty">Loading…</div>}

      {mode === 'releases' && releases.data && visibleReleases.length === 0 && (
        <div className="empty">No Helm releases found.</div>
      )}
      {mode === 'charts' && showCatalog && charts.data && charts.data.charts.length === 0 && (
        <div className="empty">No Helm charts found. Add a Helm repo first (e.g. helm repo add ...).</div>
      )}
      {mode === 'charts' && !showCatalog && releases.data && usedCharts.length === 0 && (
        <div className="empty">
          No charts deployed in the selected namespace. Tick “Repo catalog” to browse installable charts.
        </div>
      )}

      {mode === 'releases' && releases.data && visibleReleases.length > 0 && (
        <DataTable
          rows={visibleReleases}
          rowKey={(r) => `${r.namespace}/${r.name}`}
          initialSortKey="name"
          onShowDetails={(r) =>
            setDetails({
              title: `Release — ${r.name}`,
              rows: [
                ['Name', r.name],
                ['Namespace', r.namespace],
                ['Revision', r.revision],
                ['Status', r.status],
                ['Chart', r.chart],
                ['App version', r.app_version],
                ['Updated', r.updated ? new Date(r.updated).toLocaleString() : undefined],
              ],
            })
          }
          actions={[
            { label: 'History', onClick: (r) => setHistoryFor(r) },
            { label: 'Values', onClick: (r) => setValuesFor(r) },
            ...(canWrite
              ? [
                  {
                    label: 'Upgrade',
                    onClick: (r: HelmRelease) => {
                      setUpgradeFor(r);
                    },
                  },
                ]
              : []),
            ...(canDelete
              ? [
                  {
                    label: 'Uninstall',
                    danger: true,
                    onClick: (r: HelmRelease) => {
                      if (confirm(`Uninstall release "${r.name}"?`)) uninstall.mutate(r);
                    },
                  },
                ]
              : []),
          ]}
          columns={[
            { key: 'name', header: 'Name', value: (r) => r.name, className: 'mono', width: 200 },
            { key: 'namespace', header: 'Namespace', value: (r) => r.namespace, className: 'dim', width: 140 },
            { key: 'revision', header: 'Revision', value: (r) => Number(r.revision) || 0, width: 90 },
            {
              key: 'status',
              header: 'Status',
              value: (r) => r.status,
              width: 110,
              render: (r) => <span className={`badge ${r.status === 'deployed' ? 'ok' : 'warn'}`}>{r.status}</span>,
            },
            { key: 'chart', header: 'Chart', value: (r) => r.chart, className: 'dim', width: 160 },
            { key: 'app', header: 'App', value: (r) => r.app_version, className: 'dim', width: 110 },
          ]}
        />
      )}

      {mode === 'charts' && showCatalog && charts.data && charts.data.charts.length > 0 && (
        <DataTable
          rows={charts.data.charts}
          rowKey={(c) => `${c.name}:${c.version}`}
          initialSortKey="name"
          onShowDetails={(c) =>
            setDetails({
              title: `Chart — ${c.name}`,
              rows: [
                ['Chart', c.name],
                ['Version', c.version],
                ['App version', c.app_version],
                ['Description', c.description],
              ],
            })
          }
          columns={[
            { key: 'name', header: 'Chart', value: (c) => c.name, className: 'mono', width: 200 },
            { key: 'version', header: 'Version', value: (c) => c.version, width: 120 },
            { key: 'app_version', header: 'App Version', value: (c) => c.app_version ?? '', className: 'dim', width: 120 },
            { key: 'description', header: 'Description', value: (c) => c.description ?? '', className: 'dim', width: 320 },
          ]}
        />
      )}
      {mode === 'charts' && !showCatalog && usedCharts.length > 0 && (
        <DataTable
          rows={usedCharts}
          rowKey={(c) => c.chart}
          initialSortKey="name"
          onShowDetails={(c) =>
            setDetails({
              title: `Chart — ${c.name}`,
              rows: [
                ['Chart', c.name],
                ['Version', c.version],
                ['App version', c.appVersion],
                ['Releases', c.releases],
                ['Namespaces', Array.from(c.namespaces).sort().join(', ')],
              ],
            })
          }
          columns={[
            { key: 'name', header: 'Chart', value: (c) => c.name, className: 'mono', width: 200 },
            { key: 'version', header: 'Version', value: (c) => c.version, width: 120 },
            { key: 'app_version', header: 'App Version', value: (c) => c.appVersion ?? '', className: 'dim', width: 120 },
            { key: 'releases', header: 'Releases', value: (c) => c.releases, width: 100 },
            {
              key: 'namespaces',
              header: 'Namespaces',
              value: (c) => Array.from(c.namespaces).sort().join(', '),
              className: 'dim',
              width: 220,
            },
          ]}
        />
      )}

      {details && <DetailsModal title={details.title} rows={details.rows} onClose={() => setDetails(null)} />}
      {historyFor && (
        <HelmHistoryModal
          release={historyFor}
          context={scope.context}
          canWrite={canWrite}
          onClose={() => setHistoryFor(null)}
          onRolledBack={() => qc.invalidateQueries({ queryKey })}
          onToast={onToast}
        />
      )}
      {valuesFor && (
        <HelmValuesModal release={valuesFor} context={scope.context} onClose={() => setValuesFor(null)} />
      )}
      {showInstallModal && (
        <HelmInstallModal
          scope={scope}
          namespaces={selectedNamespaces.length > 0 ? selectedNamespaces : namespaces}
          onClose={() => setShowInstallModal(false)}
          onToast={(tone, text) => onToast?.(tone, text)}
          onInstalled={() => qc.invalidateQueries({ queryKey })}
        />
      )}
      {upgradeFor && (
        <HelmUpgradeModal
          release={upgradeFor}
          scope={scope}
          onClose={() => setUpgradeFor(null)}
          onToast={(tone, text) => onToast?.(tone, text)}
          onUpgraded={() => qc.invalidateQueries({ queryKey })}
        />
      )}
    </>
  );
}

interface UsedChart {
  chart: string;
  name: string;
  version: string;
  appVersion?: string;
  releases: number;
  namespaces: Set<string>;
}

function HelmHistoryModal({
  release,
  context,
  canWrite,
  onClose,
  onRolledBack,
  onToast,
}: {
  release: HelmRelease;
  context?: string;
  canWrite: boolean;
  onClose: () => void;
  onRolledBack: () => void;
  onToast?: (tone: 'success' | 'error' | 'info', text: string) => void;
}) {
  const scope: Scope = { context, namespace: release.namespace };
  const history = useQuery({
    queryKey: ['helm-history', release.name, release.namespace],
    queryFn: () => api.helmHistory(release.name, scope),
  });
  const rollback = useMutation({
    mutationFn: (rev: number) => api.helmRollback(release.name, rev, scope),
    onSuccess: () => {
      history.refetch();
      onRolledBack();
    },
  });

  return (
    <Modal title={`History — ${release.name}`} onClose={onClose}>
      {history.isLoading && <div className="dim">Loading…</div>}
      {history.isError && <div className="notice error">{(history.error as Error).message}</div>}
      {rollback.isError && <div className="notice error">{(rollback.error as Error).message}</div>}
      {history.data && (
        <table>
          <thead>
            <tr>
              <th>Rev</th>
              <th>Status</th>
              <th>Chart</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.data.history.map((h) => (
              <tr key={h.revision}>
                <td>{h.revision}</td>
                <td>
                  <span className={`badge ${h.status === 'deployed' ? 'ok' : ''}`}>{h.status}</span>
                </td>
                <td className="dim">{h.chart}</td>
                <td className="dim">{h.updated ? new Date(h.updated).toLocaleString() : '-'}</td>
                <td>
                  {canWrite && (
                    <button
                      disabled={h.status === 'deployed' || rollback.isPending}
                      onClick={() => rollback.mutate(h.revision)}
                    >
                      Rollback
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function HelmValuesModal({
  release,
  context,
  onClose,
}: {
  release: HelmRelease;
  context?: string;
  onClose: () => void;
}) {
  const values = useQuery({
    queryKey: ['helm-values', release.name, release.namespace],
    queryFn: () => api.helmValues(release.name, { context, namespace: release.namespace }),
  });
  return (
    <Modal title={`Values — ${release.name}`} onClose={onClose}>
      {values.isLoading && <div className="dim">Loading…</div>}
      {values.isError && <div className="notice error">{(values.error as Error).message}</div>}
      {values.data && (
        <pre className="mono" style={{ maxHeight: '50vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {values.data.values || '(no user-supplied values)'}
        </pre>
      )}
    </Modal>
  );
}
