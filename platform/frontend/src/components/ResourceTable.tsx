import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getDesktopEmail, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { age, statusOf } from '../utils/format';
import { downloadFile, toCsv, toTxt, type ExportFormat } from '../utils/export';
import { getWatchWorker, releaseWatchWorker } from '../utils/workerRuntime';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { NamespaceSelector } from './NamespaceSelector';
import { LoadingOverlay } from './LoadingOverlay';
import { ResourceDetail } from './ResourceDetail';
import { ColumnVisibilityPicker, useColumnVisibility } from './columnVisibility';
import { useConfirm, type ConfirmFn } from './ConfirmDialog';
import type { OpenPodLogsTerminalRequest, OpenPodTerminalRequest } from './TerminalDock';
import { uiText } from '../text';

interface Props {
  watchKey?: string;
  plural: string;
  scope: Scope;
  focusContext?: string;
  focusName?: string;
  authRecoveryRefreshToken?: number;
  namespaces: string[];
  selectedNamespaces?: string[];
  onSelectedNamespacesChange: (next: string[]) => void;
  onAddResource: () => void;
  onToast: (tone: 'info' | 'success' | 'error', text: string, durationMs?: number) => void;
  onAzureAuthRequired?: (source?: 'local' | 'cloud') => void;
  onOpenPodTerminal?: (request: OpenPodTerminalRequest) => void;
  onOpenPodLogsTerminal?: (request: OpenPodLogsTerminalRequest) => void;
}

const HAS_STATUS = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs'];
// Mirrors the `namespaced: false` entries in backend/src/kube/resources.ts —
// everything else defaults to namespaced. Kept as a short allowlist of the
// exception (cluster-scoped kinds) rather than the much longer namespaced
// list, so newly added namespaced resource kinds aren't silently misclassified.
const CLUSTER_SCOPED_TYPES = new Set([
  'namespaces',
  'nodes',
  'ingressclasses',
  'storageclasses',
  'customresourcedefinitions',
]);

type ColumnDef = {
  key: string;
  label: string;
  width: number;
  resizable?: boolean;
};

type EventTimeRange = 'all' | '5m' | '15m' | '1h' | '6h' | '24h';

const EVENT_TIME_RANGE_MS: Record<Exclude<EventTimeRange, 'all'>, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

function eventTimestampOf(o: K8sObject): number {
  const value = (o as any).lastTimestamp ?? (o as any).eventTime ?? o.metadata?.creationTimestamp;
  return new Date(value ?? '').getTime() || 0;
}

type ActionItem = {
  label: string;
  title: string;
  quickIcon?: string;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
};

type ActionContext = {
  plural: string;
  resource: K8sObject;
  canWrite: boolean;
  canDelete: boolean;
  setSelected: (value: { obj: K8sObject; tab?: string }) => void;
  restartDeployment: ReturnType<typeof useMutation<K8sObject, Error, K8sObject>>;
  del: ReturnType<typeof useMutation<{ ok: boolean }, Error, K8sObject>>;
  confirm: ConfirmFn;
};

/**
 * Capability required for each action key. Keys not listed are read-only and
 * available to everyone. Used to hide controls the current role cannot use
 * (the backend enforces the same rules authoritatively).
 */
const ACTION_CAPABILITY: Record<string, 'write' | 'delete'> = {
  'pods.shell': 'write',
  'deploy.restart': 'write',
  'common.editYaml': 'write',
  'common.delete': 'delete',
};

function allowedActionKeys(keys: string[], ctx: ActionContext): string[] {
  return keys.filter((key) => {
    const cap = ACTION_CAPABILITY[key];
    if (cap === 'write') return ctx.canWrite;
    if (cap === 'delete') return ctx.canDelete;
    return true;
  });
}

const POD_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 25, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 110 },
  { key: 'cpu', label: uiText.resource.colCpu, width: 70 },
  { key: 'memory', label: uiText.resource.colMemory, width: 85 },
  { key: 'container', label: uiText.resource.colContainers, width: 100 },
  { key: 'restarts', label: uiText.resource.colRestarts, width: 70 },
  { key: 'controlledBy', label: uiText.resource.colControlled, width: 130 },
  { key: 'node', label: uiText.resource.colNode, width: 100 },
  { key: 'qos', label: uiText.resource.colQos, width: 80 },
  { key: 'status', label: uiText.resource.colStatus, width: 80 },
  { key: 'age', label: uiText.resource.colAge, width: 70 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const DEPLOYMENT_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 110 },
  { key: 'pods', label: uiText.resource.colPods, width: 90 },
  { key: 'replicas', label: uiText.resource.colReplicas, width: 100 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'status', label: uiText.resource.colStatus, width: 120 },
  { key: 'actions', label: '', width: 220, resizable: false },
];

const DAEMONSET_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'desired', label: uiText.resource.colDesired, width: 100 },
  { key: 'current', label: uiText.resource.colCurrent, width: 100 },
  { key: 'ready', label: uiText.resource.colReady, width: 100 },
  { key: 'upToDate', label: uiText.resource.colUpToDate, width: 120 },
  { key: 'available', label: uiText.resource.colAvailable, width: 110 },
  { key: 'nodeSelector', label: uiText.resource.colNodeSelector, width: 180 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const STATEFULSET_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'desired', label: uiText.resource.colDesired, width: 100 },
  { key: 'current', label: uiText.resource.colCurrent, width: 100 },
  { key: 'ready', label: uiText.resource.colReady, width: 100 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const REPLICASET_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'pods', label: uiText.resource.colPods, width: 90 },
  { key: 'replicas', label: uiText.resource.colReplicas, width: 100 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const JOB_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'completions', label: uiText.resource.colCompletions, width: 110 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'conditions', label: uiText.resource.colConditions, width: 160 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const CRONJOB_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 240 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'schedule', label: uiText.resource.colSchedule, width: 130 },
  { key: 'suspend', label: uiText.resource.colSuspend, width: 100 },
  { key: 'active', label: uiText.resource.colActive, width: 90 },
  { key: 'lastSchedule', label: uiText.resource.colLastSchedule, width: 130 },
  { key: 'nextExecution', label: uiText.resource.colNextExecution, width: 180 },
  { key: 'timeZone', label: uiText.resource.colTimeZone, width: 120 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const CONFIGMAP_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'labels', label: uiText.resource.colLabels, width: 120 },
  { key: 'keys', label: uiText.resource.colKeys, width: 100 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const SECRET_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'labels', label: uiText.resource.colLabels, width: 120 },
  { key: 'keys', label: uiText.resource.colKeys, width: 100 },
  { key: 'type', label: uiText.resource.colType, width: 210 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 120, resizable: false },
];

const NAMESPACE_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'labels', label: uiText.resource.colLabels, width: 320 },
  { key: 'status', label: uiText.resource.colStatus, width: 120 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 92, resizable: false },
];

const EVENTS_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'type', label: uiText.resource.colType, width: 90 },
  { key: 'message', label: uiText.resource.colMessage, width: 320 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'involvedObject', label: uiText.resource.colInvolvedObject, width: 200 },
  { key: 'reason', label: uiText.resource.colReason, width: 140 },
  { key: 'source', label: uiText.resource.colSource, width: 140 },
  { key: 'count', label: uiText.resource.colCount, width: 80 },
  { key: 'age', label: uiText.resource.colLastSeen, width: 100 },
  { key: 'actions', label: '', width: 92, resizable: false },
];

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  { key: 'name', label: uiText.resource.colName, width: 260 },
  { key: 'namespace', label: uiText.resource.colNamespace, width: 140 },
  { key: 'status', label: uiText.resource.colStatus, width: 120 },
  { key: 'age', label: uiText.resource.colAge, width: 90 },
  { key: 'actions', label: '', width: 92, resizable: false },
];

const COLUMNS_BY_PLURAL: Record<string, ColumnDef[]> = {
  pods: POD_COLUMNS,
  deployments: DEPLOYMENT_COLUMNS,
  daemonsets: DAEMONSET_COLUMNS,
  statefulsets: STATEFULSET_COLUMNS,
  replicasets: REPLICASET_COLUMNS,
  jobs: JOB_COLUMNS,
  cronjobs: CRONJOB_COLUMNS,
  configmaps: CONFIGMAP_COLUMNS,
  secrets: SECRET_COLUMNS,
  namespaces: NAMESPACE_COLUMNS,
  events: EVENTS_COLUMNS,
};

const COLUMN_VISIBILITY_STORAGE_PREFIX = 'k8sExplorer.resourceColumns';

function getColumnVisibilityStorageKey(plural: string): string {
  return `${COLUMN_VISIBILITY_STORAGE_PREFIX}.${plural}`;
}

function getDefaultVisibleColumns(plural: string): string[] {
  return (COLUMNS_BY_PLURAL[plural] ?? DEFAULT_COLUMNS)
    .filter((column) => column.key !== 'select' && column.key !== 'actions')
    .map((column) => column.key);
}

function readVisibleColumns(plural: string): string[] {
  const defaults = getDefaultVisibleColumns(plural);
  if (typeof window === 'undefined') {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(getColumnVisibilityStorageKey(plural));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const valid = parsed.filter((key): key is string => typeof key === 'string' && defaults.includes(key));
    return valid.length > 0 ? valid : defaults;
  } catch {
    return defaults;
  }
}

function persistVisibleColumns(plural: string, next: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(getColumnVisibilityStorageKey(plural), JSON.stringify(next));
}

const QUICK_ACTION_KEYS_BY_PLURAL: Record<string, string[]> = {
  pods: ['pods.logs', 'pods.shell', 'common.editYaml'],
  deployments: ['deploy.restart', 'deploy.overview', 'deploy.actions', 'common.editYaml'],
};

const MENU_ACTION_KEYS_BY_PLURAL: Record<string, string[]> = {
  pods: ['pods.logs', 'pods.shell', 'common.editYaml', 'common.delete'],
  deployments: ['deploy.restart', 'deploy.overview', 'deploy.actions', 'common.editYaml', 'common.delete'],
  daemonsets: ['workload.overview', 'common.editYaml', 'common.delete'],
  statefulsets: ['workload.overview', 'common.editYaml', 'common.delete'],
  replicasets: ['workload.overview', 'common.editYaml', 'common.delete'],
  jobs: ['workload.overview', 'common.editYaml', 'common.delete'],
  cronjobs: ['workload.overview', 'common.editYaml', 'common.delete'],
};

function actionFactory(key: string, ctx: ActionContext): ActionItem {
  const o = ctx.resource;
  switch (key) {
    case 'common.showDetails':
      return { label: uiText.resource.showDetails, title: uiText.resource.openDetailsTitle, onClick: () => ctx.setSelected({ obj: o }) };
    case 'pods.logs':
      return { label: uiText.resource.viewLogs, title: uiText.resource.openPodLogsTitle, quickIcon: '≣', onClick: () => ctx.setSelected({ obj: o, tab: 'logs' }) };
    case 'pods.shell':
      return { label: uiText.resource.openShell, title: uiText.resource.openExecShellTitle, quickIcon: '>_', onClick: () => ctx.setSelected({ obj: o, tab: 'exec' }) };
    case 'deploy.restart':
      return {
        label: uiText.resource.restartDeploymentAction,
        title: uiText.resource.triggerRolloutRestart,
        quickIcon: '↻',
        onClick: () => ctx.restartDeployment.mutate(o),
        disabled: ctx.restartDeployment.isPending,
      };
    case 'deploy.overview':
      return { label: uiText.resourceDetail.overview, title: uiText.resource.openDeploymentOverview, quickIcon: '◫', onClick: () => ctx.setSelected({ obj: o, tab: 'overview' }) };
    case 'deploy.actions':
      return { label: uiText.resourceDetail.actionsTab, title: uiText.resource.openDeploymentActions, quickIcon: '⚙', onClick: () => ctx.setSelected({ obj: o, tab: 'actions' }) };
    case 'workload.overview':
      return {
        label: uiText.resourceDetail.overview,
        title: uiText.resource.openResourceKindOverview(ctx.plural.slice(0, -1)),
        onClick: () => ctx.setSelected({ obj: o, tab: 'overview' }),
      };
    case 'common.editYaml':
      return { label: uiText.resourceDetail.editYaml, title: uiText.resource.editYamlTitle, quickIcon: '✎', onClick: () => ctx.setSelected({ obj: o, tab: 'yaml' }) };
    case 'common.delete': {
      const name = o.metadata?.name;
      return {
        label: `${uiText.resourceDetail.deletePrefix} ${ctx.plural.slice(0, -1) || ctx.plural}`,
        title: `${uiText.resourceDetail.deletePrefix} ${name}`,
        danger: true,
        onClick: async () => {
          const ok = await ctx.confirm({
            title: uiText.confirmDialog.deleteTitle,
            message: uiText.confirmDialog.deleteQuestion(`${ctx.plural.slice(0, -1) || ctx.plural} "${name}"`),
            details: ctx.plural === 'pods' ? uiText.resourceDetail.destructiveActionNotice : undefined,
          });
          if (ok) ctx.del.mutate(o);
        },
      };
    }
    default:
      return { label: uiText.resourceDetail.editYaml, title: uiText.resource.editYamlTitle, quickIcon: '✎', onClick: () => ctx.setSelected({ obj: o, tab: 'yaml' }) };
  }
}

function buildQuickActions(ctx: ActionContext): ActionItem[] {
  const keys = QUICK_ACTION_KEYS_BY_PLURAL[ctx.plural] ?? ['common.editYaml'];
  return allowedActionKeys(keys, ctx).map((key) => actionFactory(key, ctx));
}

function buildMenuActions(ctx: ActionContext): ActionItem[] {
  const keys = MENU_ACTION_KEYS_BY_PLURAL[ctx.plural] ?? ['common.editYaml', 'common.delete'];
  // Every resource's action menu leads with "Show details".
  return allowedActionKeys(['common.showDetails', ...keys], ctx).map((key) => actionFactory(key, ctx));
}

const LIVE_WATCH_PLURALS = new Set([
  'pods',
  'deployments',
  'replicasets',
  'statefulsets',
  'daemonsets',
  // 'namespaces', // RBAC on some clusters permits list/get but not watch on cluster-scoped Namespaces (403 Forbidden)
  'services',
  'jobs',
  'cronjobs',
  'events',
]);

type WatchState = 'connecting' | 'live' | 'disconnected';

// When a cluster is unreachable, retry at most this many times (5s apart) before
// giving up. The user can resume by clicking Refresh.
const MAX_CONNECT_RETRIES = 10;
const RETRY_INTERVAL_MS = 5000;
const WATCH_FALLBACK_POLL_MS = 1500;
const WATCH_RESYNC_THROTTLE_MS = 5000;

// RBAC will never grant this on its own — auto-retrying it just hammers the
// cluster. Stop immediately and wait for a namespace change or explicit Refresh.
function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

type ResourceListResult = { items: K8sObject[] };
type PagedResourceListResult = { items: K8sObject[]; continue?: string };

type WatchWorkerInbound =
  | { type: 'start'; payload: { context?: string; namespace?: string; plural: string; email?: string } }
  | { type: 'stop' };

type WatchWorkerOutbound =
  | { type: 'state'; state: WatchState }
  | { type: 'event'; eventType: string; object: K8sObject }
  | { type: 'resync' }
  | { type: 'error'; message: string };

type SortDirection = 'asc' | 'desc';

export function ResourceTable({
  watchKey,
  plural,
  scope,
  focusContext,
  focusName,
  authRecoveryRefreshToken,
  namespaces,
  selectedNamespaces = [],
  onSelectedNamespacesChange,
  onAddResource,
  onToast,
  onAzureAuthRequired,
  onOpenPodTerminal,
  onOpenPodLogsTerminal,
}: Props) {
  const qc = useQueryClient();
  const { canWrite, canDelete } = usePermissions();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<{ obj: K8sObject; tab?: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [eventTimeRange, setEventTimeRange] = useState<EventTimeRange>('all');
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [openMenuDirection, setOpenMenuDirection] = useState<'down' | 'up'>('down');
  const [openMenuPos, setOpenMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [sortKey, setSortKey] = useState<string>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [autoColumnWidths, setAutoColumnWidths] = useState<Record<string, number>>({});
  const [hasManualResize, setHasManualResize] = useState(false);
  const [watchedRollout, setWatchedRollout] = useState<string | null>(null);
  const [highlightedPodRows, setHighlightedPodRows] = useState<Record<string, true>>({});
  const seenPodRowsRef = useRef<Set<string>>(new Set());
  const watchWorkerRef = useRef<Worker | null>(null);
  const tableWrapperRef = useRef<HTMLDivElement | null>(null);
  const [watchState, setWatchState] = useState<WatchState>('connecting');
  const [, setAgeTick] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const [connectionState, setConnectionState] = useState<'ok' | 'retrying' | 'stopped'>('ok');
  const failureCountRef = useRef(0);
  const lastAuthRecoveryTokenRef = useRef<number>(0);
  const [watchRetryToken, setWatchRetryToken] = useState(0);
  const [authRecoveryRefreshing, setAuthRecoveryRefreshing] = useState(false);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [hasInitialSnapshot, setHasInitialSnapshot] = useState(false);
  const lastResyncInvalidateAtRef = useRef(0);
  const listWrapperRef = tableWrapperRef;
  const lazyLoadPageSize = 50;
  const isClusterScoped = CLUSTER_SCOPED_TYPES.has(plural);
  const effectiveScope = isClusterScoped ? { ...scope, namespace: undefined } : scope;
  const isConfigMaps = plural === 'configmaps';
  const isSecrets = plural === 'secrets';
  const usesLazyPaging = isConfigMaps || isSecrets;
  const namespaceSelectionValues = useMemo(
    () => Array.from(new Set(selectedNamespaces.filter((value) => value.trim().length > 0))).sort(),
    [selectedNamespaces],
  );
  const namespaceSelectionSignature = namespaceSelectionValues.join('|');
  const queryKey = ['resource', plural, scope.context, scope.namespace, namespaceSelectionSignature];
  const pagedQueryKey = [...queryKey, 'paged'];
  const listNamespaces = async (namespacesToFetch: string[]) => {
    const responses = await Promise.allSettled(
      namespacesToFetch.map(async (namespaceName) => {
        const data = await api.listResource(plural, { ...effectiveScope, namespace: namespaceName });
        return data.items;
      }),
    );
    // Best-effort merge: a namespace the user can't access (403) shouldn't
    // block the ones they can — just skip it rather than failing the whole list.
    const items = responses.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    return Array.from(
      new Map(
        items.map((item) => {
          const key = item.metadata?.uid ?? `${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`;
          return [key, item] as const;
        }),
      ).values(),
    );
  };
  const plainList = useQuery({
    queryKey,
    queryFn: async () => {
      if (isClusterScoped) {
        return api.listResource(plural, effectiveScope);
      }

      if (scope.namespace) {
        return api.listResource(plural, { ...effectiveScope, namespace: scope.namespace });
      }

      if (namespaceSelectionValues.length > 0) {
        const items = await listNamespaces(namespaceSelectionValues);
        return { items };
      }

      return await api.listResource(plural, effectiveScope);
    },
    enabled: !!scope.context && !usesLazyPaging,
    // We drive retry cadence ourselves via refetchInterval, so disable the
    // per-fetch retries to make the failure count predictable.
    retry: false,
    // Cluster-scoped resources (namespaces, nodes, storage classes, etc.) change
    // rarely and aren't worth polling — load once and let the user hit Refresh.
    refetchOnWindowFocus: !isClusterScoped,
    // Kinds outside the live-watch allowlist (configmaps, secrets, endpoints, etc.)
    // fetch once and rely on the user hitting Refresh, same as cluster-scoped kinds.
    refetchInterval:
      connectionState === 'stopped'
        ? false
        : connectionState === 'retrying'
          ? RETRY_INTERVAL_MS
          : isClusterScoped || !LIVE_WATCH_PLURALS.has(plural)
            ? false
            // For live-watch resources, poll only while websocket isn't live yet.
            // Once watch is live, websocket events become the source of truth.
            : (watchState === 'live' || hasInitialSnapshot ? false : WATCH_FALLBACK_POLL_MS),
  });

  useAzureAuthRequiredEffect(plainList.error, onAzureAuthRequired);

  const pagedList = useInfiniteQuery<PagedResourceListResult, Error>({
    queryKey: pagedQueryKey,
    enabled: !!scope.context && usesLazyPaging,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listResourcePage(plural, effectiveScope, {
        // limit: lazyLoadPageSize,
        continue: pageParam as string | undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.continue ?? undefined,
    retry: false,
    refetchOnWindowFocus: true,
  });

  useAzureAuthRequiredEffect(pagedList.error, onAzureAuthRequired);

  const list = usesLazyPaging ? pagedList : plainList;

  const del = useMutation({
    mutationFn: (o: K8sObject) =>
      api.deleteResource(plural, o.metadata!.name!, {
        ...scope,
        namespace: o.metadata?.namespace,
      }),
    onSuccess: () => {
      onToast('success', uiText.resource.resourceDeleted);
      qc.invalidateQueries({ queryKey });
    },
    onError: (error) => onToast('error', (error as Error).message, 4200),
  });

  // Count consecutive failures; stop auto-retrying after MAX_CONNECT_RETRIES.
  // A Forbidden (403) response never resolves itself on retry — stop immediately
  // instead of burning the retry budget hammering an endpoint the user can't access.
  useEffect(() => {
    if (!list.isError) return;
    if (isForbiddenError(list.error)) {
      failureCountRef.current = MAX_CONNECT_RETRIES;
      setConnectionState('stopped');
      return;
    }
    failureCountRef.current += 1;
    setConnectionState(failureCountRef.current >= MAX_CONNECT_RETRIES ? 'stopped' : 'retrying');
  }, [list.isError, list.errorUpdatedAt, list.error]);

  // Any successful fetch resets the failure budget.
  useEffect(() => {
    if (!list.isSuccess) return;
    if (!hasInitialSnapshot) {
      setHasInitialSnapshot(true);
    }
    failureCountRef.current = 0;
    setConnectionState('ok');
    setLastUpdateAt(list.dataUpdatedAt || Date.now());
  }, [hasInitialSnapshot, list.isSuccess, list.dataUpdatedAt]);

  // User-initiated retry: reset the budget and restart polling + the watch worker.
  const retryConnection = () => {
    failureCountRef.current = 0;
    setConnectionState('ok');
    setWatchRetryToken((token) => token + 1);
    void qc.invalidateQueries({ queryKey: ['namespaces', scope.context, scope.source] });
    list.refetch();
  };

  useEffect(() => {
    if (!authRecoveryRefreshToken || !scope.context) return;
    if (lastAuthRecoveryTokenRef.current === authRecoveryRefreshToken) return;
    lastAuthRecoveryTokenRef.current = authRecoveryRefreshToken;

    setAuthRecoveryRefreshing(true);
    const refetch = usesLazyPaging ? pagedList.refetch : plainList.refetch;
    refetch()
      .catch(() => {
        // Keep existing error handling path; this refetch is best-effort.
      })
      .finally(() => setAuthRecoveryRefreshing(false));
  }, [authRecoveryRefreshToken, scope.context, usesLazyPaging, pagedList.refetch, plainList.refetch]);

  const restartDeployment = useMutation({
    mutationFn: (o: K8sObject) =>
      api.restartDeployment(o.metadata!.name!, {
        ...scope,
        namespace: o.metadata?.namespace,
      }),
    onMutate: (deployment) => {
      onToast('info', uiText.resource.restartingDeployment(deployment.metadata?.name ?? ''));
    },
    onSuccess: (deployment) => {
      setWatchedRollout(deployment.metadata?.name ?? null);
      onToast('info', uiText.resource.restartRequested(deployment.metadata?.name ?? ''));
      qc.invalidateQueries({ queryKey });
    },
    onError: (error) => onToast('error', (error as Error).message),
  });

  const namespaceFilterSet = useMemo(
    () => new Set(selectedNamespaces.filter((value) => value.trim().length > 0)),
    [selectedNamespaces],
  );
  const loadedItems = usesLazyPaging
    ? (pagedList.data?.pages ?? []).flatMap((page) => page.items)
    : (plainList.data?.items ?? []);
  const eventCutoffMs =
    plural === 'events' && eventTimeRange !== 'all' ? Date.now() - EVENT_TIME_RANGE_MS[eventTimeRange] : null;
  const items = loadedItems.filter(
    (o) => {
      const namespaceMatches = isClusterScoped || namespaceFilterSet.size === 0 || namespaceFilterSet.has(o.metadata?.namespace ?? '');
      const nameMatches = (o.metadata?.name ?? '').toLowerCase().includes(filter.toLowerCase());
      const timeMatches = eventCutoffMs === null || eventTimestampOf(o) >= eventCutoffMs;
      return namespaceMatches && nameMatches && timeMatches;
    }
  );

  const showStatus = HAS_STATUS.includes(plural);
  const isPods = plural === 'pods';
  const isDeployments = plural === 'deployments';
  const isDaemonSets = plural === 'daemonsets';
  const isStatefulSets = plural === 'statefulsets';
  const isReplicaSets = plural === 'replicasets';
  const isJobs = plural === 'jobs';
  const isCronJobs = plural === 'cronjobs';
  const podMetricTargets = useMemo(
    () =>
      isPods
        ? items
            .map((item) => ({ name: item.metadata?.name ?? '', namespace: item.metadata?.namespace ?? scope.namespace }))
            .filter((item) => item.name)
        : [],
    [isPods, items, scope.namespace],
  );
  const podMetrics = useQuery({
    queryKey: [
      'pod-table-metrics',
      scope.context,
      ...podMetricTargets.map((target) => `${target.namespace ?? ''}/${target.name}`),
    ],
    enabled: !!scope.context && isPods && podMetricTargets.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      const batch = await api.getPodMetricsBatch(
        podMetricTargets.map((target) => ({ name: target.name, namespace: target.namespace })),
        scope,
      );
      const rows = batch.items.map((item) => {
        const key = `${item.namespace ?? ''}/${item.name}`;
        if (!item.snapshot) {
          return [key, undefined] as const;
        }
        const cpuMillicores = item.snapshot.containers.reduce((sum, container) => sum + container.cpuMillicores, 0);
        const memoryBytes = item.snapshot.containers.reduce((sum, container) => sum + container.memoryBytes, 0);
        return [key, { cpuMillicores, memoryBytes }] as const;
      });

      return new Map<string, { cpuMillicores: number; memoryBytes: number } | undefined>(rows);
    },
  });
  const defaultColumnKeys = useMemo(() => getDefaultVisibleColumns(plural), [plural]);
  const columnVisibilityStorageKey = `k8sExplorer.resourceColumns.${plural}`;
  const { visibleColumns: visibleColumnKeys, toggleVisibleColumn, resetVisibleColumns, columnMenuOpen, setColumnMenuOpen } = useColumnVisibility(
    (COLUMNS_BY_PLURAL[plural] ?? DEFAULT_COLUMNS).filter((column) => column.key !== 'select' && column.key !== 'actions'),
    columnVisibilityStorageKey,
  );

  const columns = useMemo(() => {
    const allowed = new Set(visibleColumnKeys);
    return (COLUMNS_BY_PLURAL[plural] ?? DEFAULT_COLUMNS).filter(
      (column) => column.key === 'select' || column.key === 'actions' || allowed.has(column.key),
    );
  }, [plural, visibleColumnKeys]);

  const sortedItems = useMemo(() => {
    const working = items.slice();
    if (!sortKey) return working;

    working.sort((a, b) => compareResourceRows(a, b, sortKey, plural, podMetrics.data));
    return sortDirection === 'asc' ? working : working.reverse();
  }, [items, plural, podMetrics.data, sortDirection, sortKey]);

  useEffect(() => {
    if (!focusName) return;
    const normalizedFocusName = focusName.trim().toLowerCase();
    const normalizedFocusContext = focusContext?.trim().toLowerCase();
    const focusMatch = sortedItems.find((item) => {
      const itemName = item.metadata?.name?.trim().toLowerCase();
      const itemNamespace = item.metadata?.namespace?.trim().toLowerCase();
      if (itemName !== normalizedFocusName) return false;
      if (!normalizedFocusContext) return true;
      return itemNamespace === normalizedFocusContext || itemName === normalizedFocusName;
    });
    if (!focusMatch) return;

    const rowKey = focusMatch.metadata?.uid ?? `${focusMatch.metadata?.namespace}/${focusMatch.metadata?.name}`;
    const timer = window.setTimeout(() => {
      const selector = `[data-resource-row-key="${CSS.escape(rowKey)}"]`;
      const el = tableWrapperRef.current?.querySelector<HTMLElement>(selector);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusContext, focusName, sortedItems]);
  const errorMessage = list.isError ? (list.error as Error).message : '';
  const isForbiddenNow = list.isError && isForbiddenError(list.error);
  const needsNamespaceHint =
    !scope.namespace &&
    !CLUSTER_SCOPED_TYPES.has(plural) &&
    /cluster scope|forbidden/i.test(errorMessage);
  const lastUpdatedLabel = lastUpdateAt
    ? new Date(lastUpdateAt).toLocaleTimeString()
    : uiText.resourceDetail.dash;

  useEffect(() => {
    // Keep relative age values (e.g. 8m -> 8m1s style progression) moving in real-time.
    const id = window.setInterval(() => {
      setAgeTick((current) => current + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!openMenuKey) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (target.closest('.action-menu') || target.closest('.action-trigger')) {
        return;
      }

      setOpenMenuKey(null);
      setOpenMenuPos(null);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openMenuKey]);

  useEffect(() => {
    if (!columnMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.column-picker-button') || target.closest('.column-picker-menu')) {
        return;
      }
      setColumnMenuOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [columnMenuOpen]);

  useEffect(() => {
    if (!exportOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && exportRef.current?.contains(target)) return;
      setExportOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [exportOpen]);

  useEffect(() => {
    if (!usesLazyPaging) return;
    const host = listWrapperRef.current;
    if (!host) return;

    const onScroll = () => {
      if (!pagedList.hasNextPage || pagedList.isFetchingNextPage) return;
      const thresholdPx = 320;
      const remaining = host.scrollHeight - host.scrollTop - host.clientHeight;
      if (remaining <= thresholdPx) {
        void pagedList.fetchNextPage();
      }
    };

    host.addEventListener('scroll', onScroll, { passive: true });
    return () => host.removeEventListener('scroll', onScroll);
  }, [pagedList, usesLazyPaging]);

  useEffect(() => {
    if (!scope.context || !LIVE_WATCH_PLURALS.has(plural)) return;

    setWatchState('connecting');

    const worker = getWatchWorker(watchKey ?? `${plural}:${scope.context ?? ''}:${effectiveScope.namespace ?? ''}`);
    watchWorkerRef.current = worker;

    const onMessage = (event: MessageEvent<WatchWorkerOutbound>) => {
      const payload = event.data;
      if (!payload) return;
      if (payload.type === 'state') {
        setWatchState(payload.state);
        return;
      }
      if (payload.type === 'error') {
        setWatchState('disconnected');
        return;
      }
      if (payload.type === 'resync') {
        const now = Date.now();
        if (now - lastResyncInvalidateAtRef.current < WATCH_RESYNC_THROTTLE_MS) {
          return;
        }
        lastResyncInvalidateAtRef.current = now;
        // Force a full list refresh when the watch stream asks for reset,
        // so local cache catches up with any missed events.
        setLastUpdateAt(Date.now());
        void qc.invalidateQueries({ queryKey });
        return;
      }
      if (payload.type === 'event' && payload.object) {
        applyWatchEventToCache(qc, queryKey, payload.eventType, payload.object);
        setLastUpdateAt(Date.now());
      }
    };
    worker.addEventListener('message', onMessage as EventListener);

    const startMsg: WatchWorkerInbound = {
      type: 'start',
      payload: {
        email: getDesktopEmail(),
        context: scope.context,
        namespace: effectiveScope.namespace,
        plural,
      },
    };
    worker.postMessage(startMsg);

    return () => {
      const current = watchWorkerRef.current;
      if (!current) return;
      const stopMsg: WatchWorkerInbound = { type: 'stop' };
      current.postMessage(stopMsg);
      current.removeEventListener('message', onMessage as EventListener);
      if (watchKey) {
        releaseWatchWorker(watchKey);
      }
      watchWorkerRef.current = null;
    };
    // watchRetryToken is included so a user-initiated retry restarts the worker.
    // namespaceSelectionSignature is included so multi-namespace checkbox
    // changes tear down and restart the watch too - the worker only supports
    // watching a single namespace or the whole cluster, so a stale watch left
    // over from a different namespace selection can otherwise keep patching
    // cross-namespace events into the newly filtered view.
  }, [plural, qc, scope.context, effectiveScope.namespace, namespaceSelectionSignature, watchKey, watchRetryToken]);

  useEffect(() => {
    // Re-enable responsive auto-fit and reset the connection budget whenever
    // the resource/scope changes.
    setHasManualResize(false);
    setColumnWidths({});
    setHasInitialSnapshot(false);
    lastResyncInvalidateAtRef.current = 0;
    failureCountRef.current = 0;
    setConnectionState('ok');
  }, [plural, scope.context, scope.namespace, namespaceSelectionSignature]);

  useEffect(() => {
    if (hasManualResize) return;

    const fitColumns = () => {
      const host = tableWrapperRef.current;
      if (!host || columns.length === 0) return;

      const available = host.clientWidth - 2;
      if (available <= 0) return;

      const baseWidths = columns.map((column) => column.width);
      const totalBase = baseWidths.reduce((sum, width) => sum + width, 0);
      if (totalBase <= available) {
        setAutoColumnWidths({});
        return;
      }

      // Columns are wider than the viewport: shrink them to fit so there is no
      // horizontal scroll on load. Each column keeps a usable floor, and the
      // remaining width is distributed proportionally to base width so the row
      // exactly fills the available space.
      const floorFor = (key: string) =>
        key === 'select' ? 26
        : key === 'actions' ? 88
        : key === 'name' ? 120
        : key === 'status' ? 64
        : 44;
      const floors = columns.map((column) => floorFor(column.key));
      const totalFloor = floors.reduce((sum, width) => sum + width, 0);

      const next: Record<string, number> = {};
      if (totalFloor >= available) {
        // Too many columns to fit even at floor widths on this screen;
        // use floors and let the horizontal scrollbar handle the remainder.
        columns.forEach((column, index) => {
          next[column.key] = floors[index];
        });
      } else {
        const slack = available - totalFloor;
        let used = 0;
        columns.forEach((column, index) => {
          const extra = Math.floor((baseWidths[index] / totalBase) * slack);
          next[column.key] = floors[index] + extra;
          used += next[column.key];
        });
        // Hand any rounding remainder to the name column so the row fills exactly.
        const fillKey = columns.find((column) => column.key === 'name')?.key ?? columns[0].key;
        next[fillKey] += available - used;
      }
      setAutoColumnWidths(next);
    };

    // Run after first paint as well because wrapper width can be 0 during initial mount/loading.
    fitColumns();
    const rafId = window.requestAnimationFrame(fitColumns);
    window.addEventListener('resize', fitColumns);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', fitColumns);
    };
  }, [columns, hasManualResize, items.length, list.isLoading]);

  useEffect(() => {
    if (!isPods) return;

    const currentRowKeys = items.map((item) => podRowKey(item));
    if (seenPodRowsRef.current.size === 0) {
      seenPodRowsRef.current = new Set(currentRowKeys);
      return;
    }

    const addedKeys = currentRowKeys.filter((key) => !seenPodRowsRef.current.has(key));
    if (addedKeys.length > 0) {
      setHighlightedPodRows((current) => {
        const next = { ...current };
        for (const key of addedKeys) next[key] = true;
        return next;
      });

      for (const key of addedKeys) {
        window.setTimeout(() => {
          setHighlightedPodRows((current) => {
            if (!current[key]) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        }, 6500);
      }
    }

    seenPodRowsRef.current = new Set(currentRowKeys);
  }, [isPods, items]);

  useEffect(() => {
    if (plural !== 'deployments' || !watchedRollout) return;

    const deployment = items.find((item) => item.metadata?.name === watchedRollout);
    if (!deployment) return;

    const desired = Number(deployment.spec?.replicas ?? 0);
    const updated = Number((deployment.status as any)?.updatedReplicas ?? 0);
    const ready = Number((deployment.status as any)?.readyReplicas ?? 0);
    const available = Number((deployment.status as any)?.availableReplicas ?? 0);
    const progressingCondition = Array.isArray(deployment.status?.conditions)
      ? (deployment.status?.conditions as Array<{ type?: string; status?: string; reason?: string; message?: string }>)
          .find((condition) => condition.type === 'Progressing')
      : undefined;

    if (progressingCondition?.status === 'False') {
      onToast('error', progressingCondition.message || uiText.resource.rolloutFailed(watchedRollout));
      setWatchedRollout(null);
      return;
    }

    if (desired > 0 && updated === desired && ready === desired && available === desired) {
      onToast('success', uiText.resource.rolloutCompleted(watchedRollout));
      setWatchedRollout(null);
    }
  }, [list.data, onToast, plural, watchedRollout]);

  if (!scope.context) {
    return <div className="empty">{uiText.resource.selectContextToBegin}</div>;
  }

  const startResize = (key: string, startWidth: number, startX: number) => {
    setHasManualResize(true);
    const onMove = (event: MouseEvent) => {
      const nextWidth = Math.max(60, startWidth + event.clientX - startX);
      setColumnWidths((current) => ({ ...current, [key]: nextWidth }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const toggleSort = (key: string) => {
    if (!isSortableColumn(key)) return;
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  };

  const cellText = (key: string, o: K8sObject): string => {
    const meta = o.metadata ?? {};
    switch (key) {
      case 'name':
        return meta.name ?? '';
      case 'namespace':
        return meta.namespace ?? '';
      case 'labels':
        return String(Object.keys(meta.labels ?? {}).length);
      case 'keys':
        return String(Array.isArray((o as any).dataKeys) ? (o as any).dataKeys.length : Object.keys((o as any).data ?? {}).length);
      case 'type':
        return (o as any).type ?? '';
      case 'message':
        return (o as any).message ?? '';
      case 'reason':
        return (o as any).reason ?? '';
      case 'source': {
        const source = (o as any).source as { component?: string; host?: string } | undefined;
        return source?.component ? `${source.component}${source.host ? ` (${source.host})` : ''}` : '';
      }
      case 'involvedObject': {
        const involved = (o as any).involvedObject as { kind?: string; name?: string } | undefined;
        return involved ? `${involved.kind ?? ''}${involved.name ? `/${involved.name}` : ''}` : '';
      }
      case 'count':
        return String(Number((o as any).count ?? 1));
      case 'pods':
        return `${Number(o.status?.readyReplicas ?? 0)}/${Number(o.spec?.replicas ?? 0)}`;
      case 'replicas':
        return String(Number(o.spec?.replicas ?? 0));
      case 'desired':
        return String(plural === 'daemonsets' ? Number(o.status?.desiredNumberScheduled ?? 0) : Number(o.spec?.replicas ?? 0));
      case 'current':
        return String(Number(o.status?.currentReplicas ?? o.status?.currentNumberScheduled ?? 0));
      case 'ready':
        return String(Number(o.status?.readyReplicas ?? 0) || Number(o.status?.numberReady ?? 0));
      case 'upToDate':
        return String(Number(o.status?.updatedNumberScheduled ?? 0));
      case 'available':
        return String(Number(o.status?.numberAvailable ?? o.status?.availableReplicas ?? 0));
      case 'nodeSelector': {
        const sel = o.spec?.template?.spec?.nodeSelector;
        return sel ? Object.entries(sel).map(([k, v]) => `${k}=${String(v)}`).join(', ') : uiText.resourceDetail.dash;
      }
      case 'completions':
        return `${Number(o.status?.succeeded ?? 0)}/${Number(o.spec?.completions ?? 1)}`;
      case 'conditions':
        return Array.isArray(o.status?.conditions)
          ? (o.status.conditions as Array<{ type?: string; status?: string }>)
              .filter((c) => c.status === 'True')
              .map((c) => c.type)
              .join(', ')
          : uiText.resourceDetail.dash;
      case 'schedule':
        return o.spec?.schedule ?? uiText.resourceDetail.dash;
      case 'suspend':
        return String(Boolean(o.spec?.suspend));
      case 'active':
        return String(Array.isArray(o.status?.active) ? o.status.active.length : Number(o.status?.active ?? 0));
      case 'lastSchedule':
        return age(o.status?.lastScheduleTime);
      case 'nextExecution':
        return uiText.resourceDetail.dash;
      case 'timeZone':
        return o.spec?.timeZone ?? uiText.resourceDetail.dash;
      case 'cpu':
        return formatPodCpuCell(podMetrics.data?.get(`${meta.namespace}/${meta.name}`)?.cpuMillicores, o).text;
      case 'memory':
        return formatPodMemoryCell(podMetrics.data?.get(`${meta.namespace}/${meta.name}`)?.memoryBytes, o).text;
      case 'container': {
        const statuses = (o.status?.containerStatuses ?? []) as Array<{ ready?: boolean }>;
        return statuses.length > 0 ? `${statuses.filter((c) => c.ready).length}/${statuses.length}` : uiText.resourceDetail.dash;
      }
      case 'restarts': {
        const statuses = (o.status?.containerStatuses ?? []) as Array<{ restartCount?: number }>;
        return String(statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0));
      }
      case 'controlledBy': {
        const owner = (Array.isArray((meta as any).ownerReferences)
          ? (meta as any).ownerReferences[0]
          : undefined) as { kind?: string; name?: string } | undefined;
        return owner ? `${owner.kind ?? uiText.resourceDetail.dash}${owner.name ? `/${owner.name}` : ''}` : uiText.resourceDetail.dash;
      }
      case 'node':
        return o.spec?.nodeName ?? uiText.resourceDetail.dash;
      case 'qos':
        return o.status?.qosClass ?? uiText.resourceDetail.dash;
      case 'status':
        return statusOf(plural, o).text;
      case 'age':
        return plural === 'events'
          ? age(((o as any).lastTimestamp ?? (o as any).eventTime ?? meta.creationTimestamp) as string | undefined)
          : age(meta.creationTimestamp);
      default:
        return '';
    }
  };

  const handleExport = (format: ExportFormat) => {
    setExportOpen(false);
    if (sortedItems.length === 0) {
      onToast('info', uiText.resource.nothingToExport);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${plural}${scope.context ? `-${scope.context}` : ''}-${stamp}`;

    if (format === 'json') {
      downloadFile(`${base}.json`, JSON.stringify(sortedItems, null, 2), 'application/json');
    } else {
      const exportColumns = columns.filter((c) => c.key !== 'select' && c.key !== 'actions');
      const headers = exportColumns.map((c) => headerLabel(c));
      const rows = sortedItems.map((o) => exportColumns.map((c) => cellText(c.key, o)));
      if (format === 'csv') downloadFile(`${base}.csv`, toCsv(headers, rows), 'text/csv');
      else downloadFile(`${base}.txt`, toTxt(headers, rows), 'text/plain');
    }

    onToast('success', uiText.resource.exportedSummary(sortedItems.length, plural, format.toUpperCase()));
  };

  return (
    <>
      <div className="toolbar">
        <input
          className="resource-filter"
          placeholder={isPods ? uiText.resource.searchPods : uiText.resource.filterByName}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {/* <h2 className="resource-title">{plural}{scope.context ? ` - ${scope.context}` : ''}</h2> */}
        <span className="dim">{items.length} {uiText.resource.itemsCountSuffix}</span>
        <span className="dim">{uiText.resource.lastUpdatePrefix} {lastUpdatedLabel}</span>
        {authRecoveryRefreshing && (
          <span className="dim" title={uiText.resource.refreshingResourcesAfterAuth}>
            <span className="tiny-spinner" aria-label={uiText.resource.refreshingResourcesAfterAuth} /> {uiText.resource.refreshing}
          </span>
        )}
        {LIVE_WATCH_PLURALS.has(plural) && (
          <span className={`watch-indicator ${watchState}`} title={uiText.resource.realtimeWatchTitle(watchState)}>
            <span className="watch-indicator-dot" />
            <span>{watchState === 'live' ? uiText.resource.liveSync : uiText.resource.connecting}</span>
          </span>
        )}
        <div className="toolbar-actions">
          {plural === 'events' && (
            <select
              value={eventTimeRange}
              title={uiText.resource.showEventsFromRange}
              onChange={(e) => setEventTimeRange(e.target.value as EventTimeRange)}
            >
              <option value="all">{uiText.resource.allTime}</option>
              <option value="5m">{uiText.resource.last5Minutes}</option>
              <option value="15m">{uiText.resource.last15Minutes}</option>
              <option value="1h">{uiText.resource.last1Hour}</option>
              <option value="6h">{uiText.resource.last6Hours}</option>
              <option value="24h">{uiText.resource.last24Hours}</option>
            </select>
          )}
          {!CLUSTER_SCOPED_TYPES.has(plural) && (
            <NamespaceSelector
              namespaces={namespaces}
              selectedNamespaces={selectedNamespaces}
              onChange={onSelectedNamespacesChange}
            />
          )}
          <div className="export-dropdown" ref={exportRef}>
            <button
              className="export-button"
              title={uiText.resource.exportFilteredResources}
              onClick={() => setExportOpen((current) => !current)}
            >
              ⭳
            </button>
            {exportOpen && (
              <div className="export-menu">
                <button className="action-menu-item" onClick={() => handleExport('csv')}>{uiText.resource.exportAsLabel('CSV')}</button>
                <button className="action-menu-item" onClick={() => handleExport('json')}>{uiText.resource.exportAsLabel('JSON')}</button>
                <button className="action-menu-item" onClick={() => handleExport('txt')}>{uiText.resource.exportAsLabel('TXT')}</button>
              </div>
            )}
          </div>
          <button className="toolbar-refresh" onClick={retryConnection} title={connectionState === 'stopped' ? uiText.resource.retry : uiText.common.refresh}>
            ⟳
          </button>
          {canWrite && (
            <button
              className="add-resource-button"
              title={uiText.resource.addNewResource}
              aria-label={uiText.resource.addNewResourceLabel}
              onClick={onAddResource}
            >
              ＋
            </button>
          )}
        </div>
      </div>

      {list.isError && (
        <div className="notice error">
          {errorMessage}
          {connectionState === 'stopped' && isForbiddenNow &&
            uiText.resource.accessDeniedStopped}
          {connectionState === 'stopped' && !isForbiddenNow &&
            uiText.resource.stoppedAfterAttempts(MAX_CONNECT_RETRIES)}
        </div>
      )}
      {needsNamespaceHint && (
        <div className="notice">
          {uiText.resource.roleCannotListPrefix}<span className="mono">{plural}</span>{uiText.resource.roleCannotListSuffix}
        </div>
      )}
      {list.isLoading && <LoadingOverlay message={uiText.resource.loading} />}

      {!list.isLoading && items.length === 0 && <div className="empty">{uiText.resource.noResourcesFound}</div>}

      {items.length > 0 && (
        <div className={`data-table-wrapper ${hasManualResize ? 'allow-x-scroll' : 'lock-x-scroll'}`} ref={tableWrapperRef}>
        <table className="data-table">
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: columnWidths[column.key] ?? autoColumnWidths[column.key] ?? column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.key === 'actions' ? 'column-actions-header' : ''}>
                  <div
                    className={`th-content ${isSortableColumn(column.key) ? 'sortable' : ''}`}
                    title={headerTitle(column.key)}
                    onClick={() => { if (column.key !== 'actions') toggleSort(column.key); }}
                  >
                    <span
                      className={isSortableColumn(column.key) ? 'th-sort-label sortable' : 'th-sort-label'}
                    >
                      {headerLabel(column)}
                      {isSortableColumn(column.key) && sortKey === column.key && (
                        <span className="th-sort-indicator">{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>
                      )}
                    </span>
                    {column.key === 'actions' ? (
                      <ColumnVisibilityPicker
                        columns={(COLUMNS_BY_PLURAL[plural] ?? DEFAULT_COLUMNS).filter(
                          (entry) => entry.key !== 'select' && entry.key !== 'actions',
                        )}
                        visibleColumns={visibleColumnKeys}
                        onToggle={toggleVisibleColumn}
                        onReset={resetVisibleColumns}
                        isOpen={columnMenuOpen}
                        onOpenChange={setColumnMenuOpen}
                      />
                    ) : (
                      column.resizable !== false && column.label && (
                        <span
                          className="col-resizer"
                          title={uiText.resource.resizeColumnTitle(column.label)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            startResize(column.key, columnWidths[column.key] ?? column.width, event.clientX);
                          }}
                        />
                      )
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((o) => {
              const s = statusOf(plural, o);
              const podStatuses = (o.status?.containerStatuses ?? []) as Array<{ ready?: boolean; restartCount?: number }>;
              const allReady = podStatuses.length > 0 && podStatuses.every((c) => c.ready);
              const readyContainerCount = podStatuses.filter((c) => c.ready).length;
              const totalContainerCount = podStatuses.length;
              const restartCount = podStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
              const containerDetails = getContainerDetails(o);
              const readyReplicas = Number(o.status?.readyReplicas ?? 0);
              const desiredReplicas = Number(o.spec?.replicas ?? 0);
              const currentReplicas = Number(o.status?.currentReplicas ?? o.status?.currentNumberScheduled ?? 0);
              const desiredNumberScheduled = Number(o.status?.desiredNumberScheduled ?? 0);
              const updatedNumberScheduled = Number(o.status?.updatedNumberScheduled ?? 0);
              const availableReplicas = Number(o.status?.numberAvailable ?? o.status?.availableReplicas ?? 0);
              const conditionsText = Array.isArray(o.status?.conditions)
                ? (o.status.conditions as Array<{ type?: string; status?: string }>)
                    .filter((condition) => condition.status === 'True')
                    .map((condition) => condition.type)
                    .join(', ')
                : uiText.resourceDetail.dash;
              const completionsText = (() => {
                const succeeded = Number(o.status?.succeeded ?? 0);
                const target = Number(o.spec?.completions ?? 1);
                return `${succeeded}/${target}`;
              })();
              const activeCount = Array.isArray(o.status?.active)
                ? o.status.active.length
                : Number(o.status?.active ?? 0);
              const nodeSelectorText = o.spec?.template?.spec?.nodeSelector
                ? Object.entries(o.spec.template.spec.nodeSelector)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(', ')
                : uiText.resourceDetail.dash;
              const ownerRefs = Array.isArray((o.metadata as any)?.ownerReferences)
                ? ((o.metadata as any).ownerReferences as Array<{ kind?: string; name?: string }>)
                : [];
              const owner = ownerRefs[0];
              const rowKey = o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`;
              const podKey = podRowKey(o);
              const podMetric = podMetrics.data?.get(rowKey);
              const cpuCell = formatPodCpuCell(podMetric?.cpuMillicores, o);
              const memoryCell = formatPodMemoryCell(podMetric?.memoryBytes, o);
              const containerCount = (o.spec?.containers ?? []).length;
              const containerLabel =
                containerCount <= 1 ? (o.spec?.containers?.[0]?.name ?? '-') : `${containerCount} containers`;
              const rolloutProgress = plural === 'deployments' ? deploymentRolloutProgress(o) : null;
              const actionCtx: ActionContext = {
                plural,
                resource: o,
                canWrite,
                canDelete,
                setSelected,
                restartDeployment,
                del,
                confirm,
              };
              const quickActions = buildQuickActions(actionCtx);
              const actions = buildMenuActions(actionCtx);
              return (
                <tr
                  key={rowKey}
                  data-resource-row-key={rowKey}
                  className={[
                    isPods && highlightedPodRows[podKey] ? 'row-highlight-new' : '',
                    isPods && o.metadata?.deletionTimestamp ? 'row-highlight-terminating' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {columns.map((column) => {
                    switch (column.key) {
                      case 'select':
                        return <td key={column.key}><input type="checkbox" title={uiText.resource.selectRow} /></td>;
                      case 'name':
                        return <td key={column.key} className="clickable mono" title={o.metadata?.name ?? ''} onClick={() => setSelected({ obj: o })}>{o.metadata?.name}</td>;
                      case 'namespace':
                        return <td key={column.key} className="dim">{o.metadata?.namespace ?? uiText.resourceDetail.dash}</td>;
                      case 'labels': {
                        const labelEntries = Object.entries(o.metadata?.labels ?? {});
                        if (plural === 'namespaces') {
                          const text = labelEntries.map(([labelKey, value]) => `${labelKey}=${value}`).join(', ');
                          return (
                            <td key={column.key} className="dim" title={text || uiText.resource.noLabels}>
                              {text || uiText.resourceDetail.dash}
                            </td>
                          );
                        }
                        return <td key={column.key} className="dim">{labelEntries.length}</td>;
                      }
                      case 'keys':
                        return <td key={column.key} className="dim">{Array.isArray((o as any).dataKeys) ? (o as any).dataKeys.length : Object.keys((o as any).data ?? {}).length}</td>;
                      case 'type': {
                        const typeValue = String((o as any).type ?? uiText.resourceDetail.dash);
                        if (plural === 'events') {
                          const tone = typeValue === 'Warning' ? 'warn' : typeValue === 'Normal' ? 'ok' : '';
                          return <td key={column.key}><span className={`badge ${tone}`}>{typeValue}</span></td>;
                        }
                        return <td key={column.key} className="dim">{typeValue}</td>;
                      }
                      case 'message':
                        return <td key={column.key} title={String((o as any).message ?? '')}>{(o as any).message ?? uiText.resourceDetail.dash}</td>;
                      case 'reason':
                        return <td key={column.key} className="dim">{(o as any).reason ?? uiText.resourceDetail.dash}</td>;
                      case 'source': {
                        const source = (o as any).source as { component?: string; host?: string } | undefined;
                        const text = source?.component
                          ? source.host
                            ? `${source.component} (${source.host})`
                            : source.component
                          : uiText.resourceDetail.dash;
                        return <td key={column.key} className="dim" title={text}>{text}</td>;
                      }
                      case 'involvedObject': {
                        const involved = (o as any).involvedObject as { kind?: string; name?: string } | undefined;
                        return <td key={column.key} className="dim">{involved?.kind ?? uiText.resourceDetail.dash}{involved?.name ? `/${involved.name}` : ''}</td>;
                      }
                      case 'count':
                        return <td key={column.key}>{Number((o as any).count ?? 1)}</td>;
                      case 'pods':
                        return <td key={column.key}>{readyReplicas}/{desiredReplicas}</td>;
                      case 'replicas':
                        return <td key={column.key}>{desiredReplicas}</td>;
                      case 'desired':
                        return <td key={column.key}>{plural === 'daemonsets' ? desiredNumberScheduled : desiredReplicas}</td>;
                      case 'current':
                        return <td key={column.key}>{currentReplicas}</td>;
                      case 'ready':
                        return <td key={column.key}>{readyReplicas || Number(o.status?.numberReady ?? 0)}</td>;
                      case 'upToDate':
                        return <td key={column.key}>{updatedNumberScheduled}</td>;
                      case 'available':
                        return <td key={column.key}>{availableReplicas}</td>;
                      case 'nodeSelector':
                        return <td key={column.key} className="dim">{nodeSelectorText}</td>;
                      case 'completions':
                        return <td key={column.key}>{completionsText}</td>;
                      case 'conditions':
                        return <td key={column.key} className="dim">{conditionsText}</td>;
                      case 'schedule':
                        return <td key={column.key}>{o.spec?.schedule ?? uiText.resourceDetail.dash}</td>;
                      case 'suspend':
                        return <td key={column.key}>{String(Boolean(o.spec?.suspend))}</td>;
                      case 'active':
                        return <td key={column.key}>{activeCount}</td>;
                      case 'lastSchedule':
                        return <td key={column.key} className="dim">{age(o.status?.lastScheduleTime)}</td>;
                      case 'nextExecution':
                        return <td key={column.key} className="dim">{uiText.resourceDetail.dash}</td>;
                      case 'timeZone':
                        return <td key={column.key} className="dim">{o.spec?.timeZone ?? uiText.resourceDetail.dash}</td>;
                      case 'cpu':
                        return <td key={column.key} className="dim"><span title={cpuCell.title}>{cpuCell.text}</span></td>;
                      case 'memory':
                        return <td key={column.key} className="dim"><span title={memoryCell.title}>{memoryCell.text}</span></td>;
                      case 'container':
                        return (
                          <td key={column.key} className="container-cell">
                            <div className="container-ready-stack">
                              {containerDetails.length > 0 ? (
                                containerDetails.map((container) => (
                                  <span
                                    key={container.name}
                                    className={`container-dot container-state-${container.stateType}`}
                                    aria-label={uiText.resource.containerReadyAriaLabel(container.name, container.ready)}
                                  >
                                    <span className="container-details-popup" role="tooltip">
                                      <strong>{container.name}</strong>
                                      <span>{container.ready ? uiText.resourceDetail.ready : uiText.resource.notReady}</span>
                                      <span>{uiText.resource.statePrefix} {container.state}</span>
                                      <span>{uiText.resource.restartsPrefix} {container.restarts}</span>
                                    </span>
                                  </span>
                                ))
                              ) : (
                                <span className={`container-ready ${allReady ? 'ok' : 'warn'}`}>
                                  {totalContainerCount > 0 ? `${readyContainerCount}/${totalContainerCount}` : uiText.resourceDetail.dash}
                                </span>
                              )}
                            </div>
                          </td>
                        );
                      case 'restarts':
                        return <td key={column.key}>{restartCount}</td>;
                      case 'controlledBy':
                        return <td key={column.key} className="dim">{owner?.kind ?? uiText.resourceDetail.dash}{owner?.name ? `/${owner.name}` : ''}</td>;
                      case 'node':
                        return <td key={column.key} className="dim">{o.spec?.nodeName ?? uiText.resourceDetail.dash}</td>;
                      case 'qos':
                        return <td key={column.key} className="dim">{o.status?.qosClass ?? uiText.resourceDetail.dash}</td>;
                      case 'status':
                        return (
                          <td key={column.key}>
                            <span className={`badge ${s.tone}`}>{s.text}</span>
                            {rolloutProgress && <span className="badge progress-badge">{rolloutProgress}</span>}
                          </td>
                        );
                      case 'age': {
                        const timestamp = plural === 'events'
                          ? ((o as any).lastTimestamp ?? (o as any).eventTime ?? o.metadata?.creationTimestamp)
                          : o.metadata?.creationTimestamp;
                        return <td key={column.key} className="dim">{age(timestamp)}</td>;
                      }
                      case 'actions':
                        return (
                          <td key={column.key} className={`actions-cell ${openMenuKey === rowKey ? 'menu-open' : ''}`}>
                            <div className="row-actions row-actions-visible">
                              {quickActions.map((quick) => (
                                <button
                                  key={quick.label}
                                  className="quick-action icon-quick-action"
                                  title={quick.title}
                                  aria-label={quick.title}
                                  disabled={quick.disabled}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    quick.onClick();
                                  }}
                                >
                                  {quick.quickIcon ?? '•'}
                                </button>
                              ))}
                              <button
                                className="action-trigger"
                                title={uiText.resourceDetail.actionsTab}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const trigger = event.currentTarget as HTMLElement;
                                  const triggerRect = trigger.getBoundingClientRect();
                                  const estimatedMenuHeight = Math.min(actions.length * 34 + 18, 260);
                                  const estimatedMenuWidth = 220;
                                  const roomBelow = window.innerHeight - triggerRect.bottom;
                                  const direction = roomBelow < estimatedMenuHeight + 8 ? 'up' : 'down';
                                  const top = direction === 'down'
                                    ? triggerRect.bottom + 4
                                    : triggerRect.top - 4;
                                  const left = Math.max(
                                    8,
                                    Math.min(window.innerWidth - estimatedMenuWidth - 8, triggerRect.right - estimatedMenuWidth),
                                  );

                                  setOpenMenuDirection(direction);
                                  setOpenMenuPos({ top, left });
                                  setOpenMenuKey((current) => (current === rowKey ? null : rowKey));
                                }}
                              >
                                ⋮
                              </button>
                              {openMenuKey === rowKey && (
                                <div
                                  className={`action-menu ${openMenuDirection === 'up' ? 'open-up' : ''}`}
                                  style={openMenuPos ? { top: `${openMenuPos.top}px`, /*left: `${openMenuPos.left}px`*/ } : undefined}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {actions.map((action) => (
                                    <button
                                      key={action.label}
                                      className={`action-menu-item ${action.danger ? 'danger' : ''}`}
                                      title={action.title}
                                      disabled={action.disabled}
                                      onClick={() => {
                                        setOpenMenuKey(null);
                                        action.onClick();
                                      }}
                                    >
                                      {action.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {usesLazyPaging && pagedList.isFetchingNextPage && (
          <div className="empty" style={{ padding: '10px 0' }}>{uiText.resource.loadingMore}</div>
        )}
        {usesLazyPaging && pagedList.hasNextPage && !pagedList.isFetchingNextPage && (
          <div className="dim" style={{ padding: '10px 0', textAlign: 'center' }}>
            {uiText.resource.scrollToLoadMore}
          </div>
        )}
        </div>
      )}

      {selected && (
        <ResourceDetail
          plural={plural}
          object={selected.obj}
          initialTab={selected.tab}
          scope={scope}
          onClose={() => setSelected(null)}
          onChanged={() => qc.invalidateQueries({ queryKey })}
          onOpenPodTerminal={onOpenPodTerminal}
          onOpenPodLogsTerminal={onOpenPodLogsTerminal}
        />
      )}
    </>
  );
}

function podRowKey(o: K8sObject): string {
  return o.metadata?.uid ?? `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`;
}

function deploymentRolloutProgress(o: K8sObject): string | null {
  const desired = Number(o.spec?.replicas ?? 0);
  const updated = Number((o.status as any)?.updatedReplicas ?? 0);
  const ready = Number((o.status as any)?.readyReplicas ?? 0);
  const available = Number((o.status as any)?.availableReplicas ?? 0);
  if (desired <= 0) return null;
  if (updated === desired && ready === desired && available === desired) return null;
  return `${updated}/${desired} updated`;
}

function applyWatchEventToCache(
  qc: ReturnType<typeof useQueryClient>,
  queryKey: Array<string | undefined>,
  eventType: string,
  object: K8sObject,
) {
  qc.setQueryData<ResourceListResult | undefined>(queryKey, (current) => {
    if (!current) return current;
    const key = objectIdentity(object);
    if (!key) return current;

    if (eventType === 'DELETED') {
      return { items: current.items.filter((item) => objectIdentity(item) !== key) };
    }

    if (eventType !== 'ADDED' && eventType !== 'MODIFIED') {
      return current;
    }

    const index = current.items.findIndex((item) => objectIdentity(item) === key);
    if (index === -1) {
      return { items: [object, ...current.items] };
    }

    const nextItems = current.items.slice();
    nextItems[index] = object;
    return { items: nextItems };
  });
}

function objectIdentity(object: K8sObject): string | undefined {
  const uid = object.metadata?.uid;
  if (uid) return uid;
  const name = object.metadata?.name;
  if (!name) return undefined;
  return `${object.metadata?.namespace ?? ''}/${name}`;
}

function getContainerDetails(
  pod: K8sObject,
): Array<{ name: string; ready: boolean; restarts: number; state: string; stateType: 'ready' | 'running' | 'waiting' | 'terminated' | 'not-started' | 'unknown' }> {
  const specContainers = Array.isArray(pod.spec?.containers)
    ? (pod.spec.containers as Array<{ name?: string }>)
    : [];
  const statuses = Array.isArray(pod.status?.containerStatuses)
    ? (pod.status.containerStatuses as Array<{
        name?: string;
        ready?: boolean;
        restartCount?: number;
        state?: { waiting?: { reason?: string }; running?: unknown; terminated?: { reason?: string } };
      }>)
    : [];
  const byName = new Map(statuses.map((status) => [status.name ?? '', status]));

  return specContainers.map((container) => {
    const status = byName.get(container.name ?? '');
    const stateType =
      !status ? 'not-started'
      : status.ready ? 'ready'
      : status.state?.terminated ? 'terminated'
      : status.state?.waiting ? 'waiting'
      : status.state?.running ? 'running'
      : 'unknown';
    const state =
      !status ? uiText.resource.notStarted
      : status.state?.terminated?.reason
      ?? status.state?.waiting?.reason
      ?? (status.state?.running ? uiText.resource.runningState : uiText.resource.unknownState);
    return {
      name: container.name ?? uiText.resourceDetail.dash,
      ready: Boolean(status?.ready),
      restarts: Number(status?.restartCount ?? 0),
      state,
      stateType,
    };
  });
}

function isSortableColumn(key: string): boolean {
  return key !== 'select' && key !== 'actions';
}

function headerLabel(column: ColumnDef): string {
  if (column.key === 'cpu') return uiText.resource.colCpu;
  if (column.key === 'memory') return uiText.resource.colMemory;
  return column.label;
}

function headerTitle(key: string): string {
  if (key === 'cpu') return uiText.resource.cpuColumnTooltip;
  if (key === 'memory') return uiText.resource.memoryColumnTooltip;
  return isSortableColumn(key) ? uiText.resource.clickToSort : '';
}

function compareResourceRows(
  a: K8sObject,
  b: K8sObject,
  key: string,
  plural: string,
  podMetrics?: Map<string, { cpuMillicores: number; memoryBytes: number } | undefined>,
): number {
  const av = sortableValueOf(a, key, plural, podMetrics);
  const bv = sortableValueOf(b, key, plural, podMetrics);
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { sensitivity: 'base', numeric: true });
}

function sortableValueOf(
  o: K8sObject,
  key: string,
  plural: string,
  podMetrics?: Map<string, { cpuMillicores: number; memoryBytes: number } | undefined>,
): string | number {
  const rowKey = `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`;
  const podMetric = podMetrics?.get(rowKey);
  const containerStatuses = Array.isArray(o.status?.containerStatuses) ? o.status.containerStatuses : [];
  const ownerRefs = Array.isArray((o.metadata as any)?.ownerReferences)
    ? ((o.metadata as any).ownerReferences as Array<{ kind?: string; name?: string }>)
    : [];

  switch (key) {
    case 'name':
      return o.metadata?.name ?? '';
    case 'namespace':
      return o.metadata?.namespace ?? '';
    case 'cpu':
      return podMetric?.cpuMillicores ?? sumPodResourceRequest(o, 'cpu', parseCpuToMillicores);
    case 'memory':
      return podMetric?.memoryBytes ?? sumPodResourceRequest(o, 'memory', parseMemoryToBytes);
    case 'container':
      return containerStatuses.filter((status: any) => status.ready).length;
    case 'restarts':
      return containerStatuses.reduce((sum: number, status: any) => sum + (status.restartCount ?? 0), 0);
    case 'controlledBy': {
      const owner = ownerRefs[0];
      return `${owner?.kind ?? ''}/${owner?.name ?? ''}`;
    }
    case 'node':
      return o.spec?.nodeName ?? '';
    case 'qos':
      return o.status?.qosClass ?? '';
    case 'status':
      return statusOf(plural, o).text;
    case 'age':
      return plural === 'events'
        ? eventTimestampOf(o)
        : new Date(o.metadata?.creationTimestamp ?? '').getTime() || 0;
    case 'pods':
      return Number(o.status?.readyReplicas ?? 0);
    case 'replicas':
    case 'desired':
      return Number(o.spec?.replicas ?? o.status?.desiredNumberScheduled ?? 0);
    case 'current':
      return Number(o.status?.currentReplicas ?? o.status?.currentNumberScheduled ?? 0);
    case 'ready':
      return Number(o.status?.readyReplicas ?? o.status?.numberReady ?? 0);
    case 'upToDate':
      return Number(o.status?.updatedNumberScheduled ?? 0);
    case 'available':
      return Number(o.status?.numberAvailable ?? o.status?.availableReplicas ?? 0);
    case 'nodeSelector':
      return o.spec?.template?.spec?.nodeSelector
        ? Object.entries(o.spec.template.spec.nodeSelector)
            .map(([nodeKey, value]) => `${nodeKey}=${String(value)}`)
            .join(', ')
        : '';
    case 'completions':
      return Number(o.status?.succeeded ?? 0);
    case 'conditions':
      return Array.isArray(o.status?.conditions)
        ? (o.status.conditions as Array<{ type?: string; status?: string }>)
            .filter((condition) => condition.status === 'True')
            .map((condition) => condition.type)
            .join(', ')
        : '';
    case 'schedule':
      return o.spec?.schedule ?? '';
    case 'suspend':
      return o.spec?.suspend ? 1 : 0;
    case 'active':
      return Array.isArray(o.status?.active) ? o.status.active.length : Number(o.status?.active ?? 0);
    case 'lastSchedule':
      return new Date(o.status?.lastScheduleTime ?? '').getTime() || 0;
    case 'timeZone':
      return o.spec?.timeZone ?? '';
    case 'labels':
      return Object.keys(o.metadata?.labels ?? {}).length;
    case 'keys':
      return Object.keys((o as any).data ?? {}).length;
    case 'type':
      return (o as any).type ?? '';
    case 'message':
      return (o as any).message ?? '';
    case 'reason':
      return (o as any).reason ?? '';
    case 'source': {
      const source = (o as any).source as { component?: string; host?: string } | undefined;
      return source?.component ?? '';
    }
    case 'involvedObject': {
      const involved = (o as any).involvedObject as { kind?: string; name?: string } | undefined;
      return `${involved?.kind ?? ''}/${involved?.name ?? ''}`;
    }
    case 'count':
      return Number((o as any).count ?? 1);
    default:
      return '';
  }
}

function formatPodCpuCell(cpuMillicores: number | undefined, pod: K8sObject): { text: string; title: string } {
  if (typeof cpuMillicores === 'number' && Number.isFinite(cpuMillicores) && cpuMillicores >= 0) {
    return {
      text: `${Number(cpuMillicores).toFixed(1)}m`,
      title: uiText.resource.liveCpuUsageTooltip(Number(cpuMillicores)),
    };
  }

  const requestedMillicores = sumPodResourceRequest(pod, 'cpu', parseCpuToMillicores);
  if (requestedMillicores > 0) {
    return {
      text: `${Math.round(requestedMillicores)}m req`,
      title: uiText.resource.fallbackCpuRequestTooltip(Math.round(requestedMillicores)),
    };
  }

  return {
    text: uiText.resourceDetail.dash,
    title: uiText.resource.noCpuMetricsConfigured,
  };
}

function formatPodMemoryCell(memoryBytes: number | undefined, pod: K8sObject): { text: string; title: string } {
  if (typeof memoryBytes === 'number' && Number.isFinite(memoryBytes) && memoryBytes > 0) {
    return {
      text: formatBytes(memoryBytes),
      title: uiText.resource.liveMemoryUsageTooltip,
    };
  }

  const requestedBytes = sumPodResourceRequest(pod, 'memory', parseMemoryToBytes);
  if (requestedBytes > 0) {
    return {
      text: `${formatBytes(requestedBytes)} req`,
      title: uiText.resource.fallbackMemoryRequestTooltip,
    };
  }

  return {
    text: uiText.resourceDetail.dash,
    title: uiText.resource.noMemoryMetricsConfigured,
  };
}

function sumPodResourceRequest(
  pod: K8sObject,
  key: 'cpu' | 'memory',
  parse: (value?: string) => number,
): number {
  const containers = Array.isArray(pod.spec?.containers) ? pod.spec.containers : [];
  return containers.reduce((sum: number, container: any) => {
    return sum + parse(container?.resources?.requests?.[key]);
  }, 0);
}

function parseCpuToMillicores(value?: string): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1_000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1000 : 0;
}

function parseMemoryToBytes(value?: string): number {
  if (!value) return 0;
  const match = /^([0-9.]+)([KMGTE]i|[kMGTPE]|m)?$/.exec(value);
  if (!match) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const factors: Record<string, number> = {
    '': 1,
    k: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    P: 1_000_000_000_000_000,
    E: 1_000_000_000_000_000_000,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    m: 0.001,
  };
  return amount * (factors[unit] ?? 1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mi`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
  return `${bytes.toFixed(0)} B`;
}
