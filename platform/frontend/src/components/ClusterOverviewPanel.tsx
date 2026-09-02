import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { uiText } from '../text';
import { NamespaceSelector } from './NamespaceSelector';

type OverviewKind = 'pods' | 'deployments' | 'replicasets' | 'cronjobs' | 'daemonsets' | 'statefulsets' | 'jobs' | 'helmreleases';

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
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
}

export function ClusterOverviewPanel({ scope, namespaces, selectedNamespaces, onSelectedNamespacesChange, onOpenResource, onOpenHelmReleases, onAzureAuthRequired }: Props) {
  const clusterScope = { ...scope, namespace: undefined };
  const overview = useQuery({
    queryKey: ['cluster-overview', scope.context, scope.source, ...selectedNamespaces],
    enabled: !!scope.context,
    queryFn: async () => {
      const queryScopes = selectedNamespaces.length > 0
        ? selectedNamespaces.map((namespace) => ({ ...scope, namespace }))
        : [clusterScope];
      const resourceKinds = OVERVIEW_KINDS.filter(({ key }) => key !== 'helmreleases');
      const resourceResults = await Promise.all(
        resourceKinds.map(async ({ key }) => {
          const results = await Promise.all(queryScopes.map((queryScope) => api.listResource(key, queryScope)));
          return [key, results.flatMap((result) => result.items)] as const;
        }),
      );
      const helmResults = await Promise.all(queryScopes.map((queryScope) => api.helmReleases(queryScope)));
      return {
        resources: Object.fromEntries(resourceResults) as Partial<Record<OverviewKind, K8sObject[]>>,
        helmReleases: helmResults.flatMap((result) => result.releases),
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
            </button>
          ))}
        </div>
      </section>
    </>
  );
}