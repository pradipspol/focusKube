import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { age, statusOf } from '../utils/format';
import { downloadFile, toCsv, toTxt, type ExportFormat } from '../utils/export';
import { getWatchWorker, releaseWatchWorker } from '../utils/workerRuntime';
import { useAzureAuthRequiredEffect } from '../hooks/useAzureAuthRequired';
import { NamespaceSelector } from './NamespaceSelector';
import { LoadingOverlay } from './LoadingOverlay';
import { ResourceDetail } from './ResourceDetail';
import { EmptyState } from './EmptyState';
import { RefreshButton } from './RefreshButton';
import { Notice } from './Notice';
import { ColumnVisibilityPicker, useColumnVisibility } from './columnVisibility';
import { AnchoredMenu } from './AnchoredMenu';
import { useConfirm, type ConfirmFn } from './ConfirmDialog';
import type { OpenPodLogsTerminalRequest, OpenPodTerminalRequest } from './TerminalDock';
import type { OpenDeploymentLogsTerminalRequest } from './TerminalDock';
import { uiText } from '../text';
import { Spinner } from './Spinner';
import { ActionMenuTrigger } from './ActionMenuTrigger';
import { CloseButton } from './CloseButton';
import { IconActionButton } from './IconActionButton';
import { ArrowDown, ArrowUp, CircleAlert, Download, Ellipsis, LayoutDashboard, List, Pencil, Plus, RotateCw, Terminal, TriangleAlert, type LucideIcon } from 'lucide-react';

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
  onOpenDeploymentLogsTerminal?: (request: OpenDeploymentLogsTerminalRequest) => void;
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
  quickIcon?: LucideIcon;
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
  deployments: ['deploy.restart', 'deploy.logs', 'deploy.overview', 'deploy.actions', 'common.editYaml'],
};

const MENU_ACTION_KEYS_BY_PLURAL: Record<string, string[]> = {
  pods: ['pods.logs', 'pods.shell', 'common.editYaml', 'common.delete'],
  deployments: ['deploy.restart', 'deploy.logs', 'deploy.overview', 'deploy.actions', 'common.editYaml', 'common.delete'],
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
      return { label: uiText.resource.viewLogs, title: uiText.resource.openPodLogsTitle, quickIcon: List, onClick: () => ctx.setSelected({ obj: o, tab: 'logs' }) };
    case 'pods.shell':
      return { label: uiText.resource.openShell, title: uiText.resource.openExecShellTitle, quickIcon: Terminal, onClick: () => ctx.setSelected({ obj: o, tab: 'exec' }) };
    case 'deploy.restart':
      return {
        label: uiText.resource.restartDeploymentAction,
        title: uiText.resource.triggerRolloutRestart,
        quickIcon: RotateCw,
        onClick: () => ctx.restartDeployment.mutate(o),
        disabled: ctx.restartDeployment.isPending,
      };
    case 'deploy.overview':
      return { label: uiText.resourceDetail.overview, title: uiText.resource.openDeploymentOverview, quickIcon: LayoutDashboard, onClick: () => ctx.setSelected({ obj: o, tab: 'overview' }) };
    case 'deploy.logs':
      return { label: uiText.resourceDetail.logs, title: uiText.resource.openDeploymentLogs, quickIcon: List, onClick: () => ctx.setSelected({ obj: o, tab: 'logs' }) };
    case 'deploy.actions':
      return { label: uiText.resourceDetail.actionsTab, title: uiText.resource.openDeploymentActions, quickIcon: Ellipsis, onClick: () => ctx.setSelected({ obj: o, tab: 'actions' }) };
    case 'workload.overview':
      return {
        label: uiText.resourceDetail.overview,
        title: uiText.resource.openResourceKindOverview(ctx.plural.slice(0, -1)),
        onClick: () => ctx.setSelected({ obj: o, tab: 'overview' }),
      };
    case 'common.editYaml':
      return { label: uiText.resourceDetail.editYaml, title: uiText.resource.editYamlTitle, quickIcon: Pencil, onClick: () => ctx.setSelected({ obj: o, tab: 'yaml' }) };
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
      return { label: uiText.resourceDetail.editYaml, title: uiText.resource.editYamlTitle, quickIcon: Pencil, onClick: () => ctx.setSelected({ obj: o, tab: 'yaml' }) };
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

type PagedResourceListResult = { items: K8sObject[]; continue?: string; resourceVersion?: string; remainingItemCount?: number; namespaceIndex: number };
type ResourcePageParam = { namespaceIndex: number; continue?: string };
type PodHealthDetails = {
  pod: K8sObject;
  severity: 'warning' | 'error';
  statusText: string;
  reasons: string[];
};

type WatchWorkerInbound =
  | { type: 'start'; payload: { context?: string; namespace?: string; plural: string; email?: string; resourceVersion?: string } }
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
  onOpenDeploymentLogsTerminal,
}: Props) {
  const qc = useQueryClient();
  const { canWrite, canDelete } = usePermissions();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<{ obj: K8sObject; tab?: string } | null>(null);
  const [warningDetails, setWarningDetails] = useState<PodHealthDetails | null>(null);
  const [filter, setFilter] = useState('');
  const [eventTimeRange, setEventTimeRange] = useState<EventTimeRange>('all');
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const rowActionAnchorRef = useRef<HTMLElement | null>(null);
  const [sortKey, setSortKey] = useState<string>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [autoColumnWidths, setAutoColumnWidths] = useState<Record<string, number>>({});
  const [hasManualResize, setHasManualResize] = useState(false);
  const [watchedRollout, setWatchedRollout] = useState<string | null>(null);
  const [highlightedPodRows, setHighlightedPodRows] = useState<Record<string, true>>({});
  const seenPodRowsRef = useRef<Set<string>>(new Set());
  const tableWrapperRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
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
  const namespaceSelectionValues = useMemo(
    () => Array.from(new Set(selectedNamespaces.filter((value) => value.trim().length > 0))).sort(),
    [selectedNamespaces],
  );
  const namespaceSelectionSignature = namespaceSelectionValues.join('|');
  const isMultiNamespaceSelection =
    !isClusterScoped && !effectiveScope.namespace && namespaceSelectionValues.length > 1;
  const queryKey = useMemo(
    () => ['resource', plural, scope.context, scope.namespace, namespaceSelectionSignature],
    [plural, scope.context, scope.namespace, namespaceSelectionSignature],
  );
  const pagedQueryKey = useMemo(() => [...queryKey, 'paged'], [queryKey]);
  const pagedList = useInfiniteQuery<PagedResourceListResult, Error>({
    queryKey: pagedQueryKey,
    enabled: !!scope.context,
    initialPageParam: { namespaceIndex: 0 } as ResourcePageParam,
    queryFn: async ({ pageParam }) => {
      const pageNamespaces = isClusterScoped
        ? [undefined]
        : scope.namespace
          ? [scope.namespace]
          : namespaceSelectionValues.length > 0
            ? namespaceSelectionValues
            : [undefined];
      let namespaceIndex = (pageParam as ResourcePageParam).namespaceIndex;
      let continuation = (pageParam as ResourcePageParam).continue;
      while (namespaceIndex < pageNamespaces.length) {
        const namespace = pageNamespaces[namespaceIndex];
        try {
          const page = await api.listResourcePage(plural, { ...effectiveScope, namespace }, {
            limit: lazyLoadPageSize,
            continue: continuation,
          });
          return { ...page, namespaceIndex };
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 403 && namespaceSelectionValues.length > 0)) throw error;
          namespaceIndex += 1;
          continuation = undefined;
        }
      }
      return { items: [], namespaceIndex };
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.continue) return { namespaceIndex: lastPage.namespaceIndex, continue: lastPage.continue };
      const pageNamespaceCount = isClusterScoped ? 1 : scope.namespace ? 1 : namespaceSelectionValues.length || 1;
      return lastPage.namespaceIndex + 1 < pageNamespaceCount
        ? { namespaceIndex: lastPage.namespaceIndex + 1 }
        : undefined;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval:
      connectionState === 'stopped'
        ? false
        : connectionState === 'retrying'
          ? RETRY_INTERVAL_MS
          : isClusterScoped || !LIVE_WATCH_PLURALS.has(plural)
            ? false
            : isMultiNamespaceSelection
              ? watchState === 'live' ? false : RETRY_INTERVAL_MS
            : (watchState === 'live' || hasInitialSnapshot ? false : WATCH_FALLBACK_POLL_MS),
  });
  const namespaceCountQueryKey = useMemo(
    () => ['resource-count', plural, scope.context, scope.source, namespaceSelectionSignature],
    [plural, scope.context, scope.source, namespaceSelectionSignature],
  );
  const namespaceCountQuery = useQuery<number | undefined>({
    queryKey: namespaceCountQueryKey,
    enabled: isMultiNamespaceSelection && !!scope.context,
    retry: false,
    queryFn: async () => {
      const { total } = await api.resourceCount(plural, namespaceSelectionValues, effectiveScope);
      return total;
    },
  });

  useAzureAuthRequiredEffect(pagedList.error, onAzureAuthRequired);

  const list = pagedList;

  const del = useMutation({
    mutationFn: (o: K8sObject) =>
      api.deleteResource(plural, o.metadata!.name!, {
        ...scope,
        namespace: o.metadata?.namespace,
      }),
    onSuccess: () => {
      onToast('success', uiText.resource.resourceDeleted);
      void qc.resetQueries({ queryKey: pagedQueryKey });
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
    void qc.resetQueries({ queryKey: pagedQueryKey });
    void qc.resetQueries({ queryKey: namespaceCountQueryKey });
  };

  useEffect(() => {
    if (!authRecoveryRefreshToken || !scope.context) return;
    if (lastAuthRecoveryTokenRef.current === authRecoveryRefreshToken) return;
    lastAuthRecoveryTokenRef.current = authRecoveryRefreshToken;

    setAuthRecoveryRefreshing(true);
    qc.resetQueries({ queryKey: pagedQueryKey })
      .catch(() => {
        // Keep existing error handling path; this refetch is best-effort.
      })
      .finally(() => setAuthRecoveryRefreshing(false));
  }, [authRecoveryRefreshToken, scope.context, qc, pagedQueryKey]);

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
      void qc.resetQueries({ queryKey: pagedQueryKey });
    },
    onError: (error) => onToast('error', (error as Error).message),
  });

  const namespaceFilterSet = useMemo(
    () => new Set(selectedNamespaces.filter((value) => value.trim().length > 0)),
    [selectedNamespaces],
  );
  const loadedItems = (pagedList.data?.pages ?? []).flatMap((page) => page.items);
  const pagedTotalResourceCount = useMemo(() => {
    const pages = pagedList.data?.pages ?? [];
    if (pages.length > 0 && !pagedList.hasNextPage && !pagedList.isFetchingNextPage) return loadedItems.length;

    const firstPagesByNamespace = new Map<number, PagedResourceListResult>();
    for (const page of pages) {
      if (!firstPagesByNamespace.has(page.namespaceIndex)) firstPagesByNamespace.set(page.namespaceIndex, page);
    }
    const namespaceCount = isClusterScoped ? 1 : scope.namespace ? 1 : namespaceSelectionValues.length || 1;
    if (firstPagesByNamespace.size < namespaceCount) return undefined;

    let total = 0;
    for (const page of firstPagesByNamespace.values()) {
      if (typeof page.remainingItemCount === 'number') total += page.items.length + page.remainingItemCount;
      else if (!page.continue) total += page.items.length;
      else return undefined;
    }
    return total;
  }, [isClusterScoped, loadedItems.length, namespaceSelectionValues.length, pagedList.data?.pages, pagedList.hasNextPage, pagedList.isFetchingNextPage, scope.namespace]);
  const totalResourceCount = namespaceCountQuery.data ?? pagedTotalResourceCount;
  const snapshotResourceVersion = pagedList.data?.pages[0]?.resourceVersion;
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
  const isSearchingRemainingPages = filter.trim().length > 0
    && items.length === 0
    && (pagedList.hasNextPage || pagedList.isFetchingNextPage);

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
      if (target && (exportRef.current?.contains(target) || target.closest('.export-menu'))) return;
      setExportOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [exportOpen]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !pagedList.hasNextPage || pagedList.isFetchingNextPage) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void pagedList.fetchNextPage();
      }
    }, { rootMargin: '320px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [pagedList.fetchNextPage, pagedList.hasNextPage, pagedList.isFetchingNextPage, loadedItems.length]);

  useEffect(() => {
    if (!filter.trim() || items.length > 0 || !pagedList.hasNextPage || pagedList.isFetchingNextPage) return;

    const timer = window.setTimeout(() => {
      void pagedList.fetchNextPage();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter, items.length, pagedList.fetchNextPage, pagedList.hasNextPage, pagedList.isFetchingNextPage]);

  useEffect(() => {
    if (!scope.context || !LIVE_WATCH_PLURALS.has(plural)) return;
    if (!snapshotResourceVersion) return;

    const watchNamespaces = isClusterScoped
      ? [undefined]
      : effectiveScope.namespace
        ? [effectiveScope.namespace]
        : namespaceSelectionValues.length > 0
          ? namespaceSelectionValues
          : [undefined];

    setWatchState('connecting');

    let pendingResyncTimer: number | null = null;
    const namespaceStates = new Map<string, WatchState>();
    const watchSubscriptions: Array<{ key: string; worker: Worker; onMessage: (event: MessageEvent<WatchWorkerOutbound>) => void }> = [];

    const updateNamespaceState = (key: string, state: WatchState) => {
      namespaceStates.set(key, state);
      const states = [...namespaceStates.values()];
      setWatchState(
        states.every((value) => value === 'live')
          ? 'live'
          : states.some((value) => value === 'disconnected')
            ? 'disconnected'
            : 'connecting',
      );
    };

    const requestSnapshotReset = () => {
      const now = Date.now();
      const elapsed = now - lastResyncInvalidateAtRef.current;
      if (elapsed >= WATCH_RESYNC_THROTTLE_MS) {
        lastResyncInvalidateAtRef.current = now;
        void qc.resetQueries({ queryKey: pagedQueryKey });
        void qc.resetQueries({ queryKey: namespaceCountQueryKey });
        return;
      }
      if (pendingResyncTimer !== null) return;
      pendingResyncTimer = window.setTimeout(() => {
        pendingResyncTimer = null;
        lastResyncInvalidateAtRef.current = Date.now();
        void qc.resetQueries({ queryKey: pagedQueryKey });
        void qc.resetQueries({ queryKey: namespaceCountQueryKey });
      }, WATCH_RESYNC_THROTTLE_MS - elapsed);
    };

    for (const namespace of watchNamespaces) {
      const key = `${watchKey ?? `${plural}:${scope.context}:${effectiveScope.namespace ?? ''}`}:namespace:${namespace ?? '*'}`;
      namespaceStates.set(key, 'connecting');
      const worker = getWatchWorker(key);
      const onMessage = (event: MessageEvent<WatchWorkerOutbound>) => {
        const payload = event.data;
        if (!payload) return;
        if (payload.type === 'state') {
          updateNamespaceState(key, payload.state);
          return;
        }
        if (payload.type === 'error') {
          updateNamespaceState(key, 'disconnected');
          return;
        }
        if (payload.type === 'resync') {
          setLastUpdateAt(Date.now());
          requestSnapshotReset();
          return;
        }
        if (payload.type === 'event' && payload.object) {
          if (payload.eventType === 'ADDED' || payload.eventType === 'DELETED') {
            requestSnapshotReset();
          } else if (payload.eventType === 'MODIFIED') {
            applyWatchEventToPagedCache(qc, pagedQueryKey, payload.eventType, payload.object);
          }
          setLastUpdateAt(Date.now());
        }
      };
      worker.addEventListener('message', onMessage as EventListener);
      watchSubscriptions.push({ key, worker, onMessage });

      const startMsg: WatchWorkerInbound = {
        type: 'start',
        payload: {
          context: scope.context,
          namespace,
          plural,
          resourceVersion: snapshotResourceVersion,
        },
      };
      worker.postMessage(startMsg);
    }

    return () => {
      if (pendingResyncTimer !== null) window.clearTimeout(pendingResyncTimer);
      for (const { key, worker, onMessage } of watchSubscriptions) {
        worker.postMessage({ type: 'stop' } satisfies WatchWorkerInbound);
        worker.removeEventListener('message', onMessage as EventListener);
        releaseWatchWorker(key);
      }
    };
    // watchRetryToken is included so a user-initiated retry restarts the worker.
    // Namespace selection changes tear down and restart all scoped watches.
  }, [plural, qc, scope.context, effectiveScope.namespace, isClusterScoped, isMultiNamespaceSelection, namespaceSelectionValues, namespaceSelectionSignature, watchKey, watchRetryToken, snapshotResourceVersion, pagedQueryKey]);

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
    return <EmptyState>{uiText.resource.selectContextToBegin}</EmptyState>;
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
        <span className="dim">
          {loadedItems.length} / {totalResourceCount === undefined
            ? uiText.resource.unknownTotal
            : pagedList.hasNextPage ? `${totalResourceCount}` : totalResourceCount} {uiText.resource.resourcesCountSuffix}
        </span>
        {filter.trim() && <span className="dim">{uiText.resource.matchesCount(items.length)}</span>}
        <span className="dim">{uiText.resource.lastUpdatePrefix} {lastUpdatedLabel}</span>
        {isSearchingRemainingPages && (
          <span className="dim">
            <Spinner hidden /> {uiText.resource.searchingRemaining}
          </span>
        )}
        {authRecoveryRefreshing && (
          <span className="dim" title={uiText.resource.refreshingResourcesAfterAuth}>
            <Spinner label={uiText.resource.refreshingResourcesAfterAuth} /> {uiText.resource.refreshing}
          </span>
        )}
        {LIVE_WATCH_PLURALS.has(plural) && (
          <span className={`watch-indicator ${watchState}`} title={uiText.resource.realtimeWatchTitle(watchState)}>
            <span className="watch-indicator-dot" />
            <span>{watchState === 'live' ? uiText.resource.liveSync : uiText.resource.connecting}</span>
          </span>
        )}
        <div className="toolbar-actions resource-table-toolbar-actions">
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
            <IconActionButton
              baseClassName="toolbar-icon-action export-button"
              title={uiText.resource.exportFilteredResources}
              ariaExpanded={exportOpen}
              onClick={() => setExportOpen((current) => !current)}
            >
              <Download aria-hidden="true" />
            </IconActionButton>
            {exportOpen && (
              <AnchoredMenu anchorRef={exportRef} ariaLabel={uiText.resource.exportFilteredResources} className="export-menu">
                <button className="action-menu-item" onClick={() => handleExport('csv')}>{uiText.resource.exportAsLabel('CSV')}</button>
                <button className="action-menu-item" onClick={() => handleExport('json')}>{uiText.resource.exportAsLabel('JSON')}</button>
                <button className="action-menu-item" onClick={() => handleExport('txt')}>{uiText.resource.exportAsLabel('TXT')}</button>
              </AnchoredMenu>
            )}
          </div>
          <RefreshButton onClick={retryConnection} title={connectionState === 'stopped' ? uiText.resource.retry : uiText.common.refresh} />
          {canWrite && (
            <IconActionButton
              baseClassName="toolbar-icon-action add-resource-button"
              title={uiText.resource.addNewResource}
              ariaLabel={uiText.resource.addNewResourceLabel}
              onClick={onAddResource}
            >
              <Plus aria-hidden="true" />
            </IconActionButton>
          )}
        </div>
      </div>

      {list.isError && (
        <Notice variant="error">
          {errorMessage}
          {connectionState === 'stopped' && isForbiddenNow &&
            uiText.resource.accessDeniedStopped}
          {connectionState === 'stopped' && !isForbiddenNow &&
            uiText.resource.stoppedAfterAttempts(MAX_CONNECT_RETRIES)}
        </Notice>
      )}
      {needsNamespaceHint && (
        <Notice>
          {uiText.resource.roleCannotListPrefix}<span className="mono">{plural}</span>{uiText.resource.roleCannotListSuffix}
        </Notice>
      )}
      {list.isLoading && <LoadingOverlay message={uiText.resource.loading} />}

      {!list.isLoading && !isSearchingRemainingPages && items.length === 0 && (
        <EmptyState>{uiText.resource.noResourcesFound}</EmptyState>
      )}

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
                        <span className="th-sort-indicator" aria-hidden="true">{sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</span>
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
              const resourceName = o.metadata?.name ?? '';
              const podHealth = isPods ? currentPodHealth(o) : null;
              const podMetric = podMetrics.data?.get(`${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`);
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
                        return (
                          <td key={column.key} className="mono">
                            <span className="resource-name-cell">
                              <button type="button" className="resource-name-link" title={resourceName} onClick={() => setSelected({ obj: o })}>
                                {resourceName}
                              </button>
                              {podHealth && (
                                <button
                                  type="button"
                                  className={`resource-health-indicator ${podHealth.severity}`}
                                  title={uiText.resource.inspectHealth}
                                  aria-label={uiText.resource.inspectHealth}
                                  onClick={() => setWarningDetails(podHealth)}
                                >
                                  {podHealth.severity === 'error'
                                    ? <CircleAlert size={14} aria-hidden="true" />
                                    : <TriangleAlert size={14} aria-hidden="true" />}
                                </button>
                              )}
                            </span>
                          </td>
                        );
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
                              {quickActions.map((quick) => {
                                const QuickIcon = quick.quickIcon;
                                return (
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
                                    {QuickIcon ? <QuickIcon size={14} aria-hidden="true" /> : null}
                                  </button>
                                );
                              })}
                              <ActionMenuTrigger
                                label={uiText.resourceDetail.actionsTab}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  rowActionAnchorRef.current = event.currentTarget;
                                  setOpenMenuKey((current) => (current === rowKey ? null : rowKey));
                                }}
                              />
                              {openMenuKey === rowKey && (
                                <AnchoredMenu anchorRef={rowActionAnchorRef} ariaLabel={uiText.resourceDetail.actionsTab}>
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
                                </AnchoredMenu>
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
        {pagedList.hasNextPage && <div ref={loadMoreRef} aria-hidden="true" style={{ height: 1 }} />}
        </div>
      )}

      {selected && (
        <ResourceDetail
          plural={plural}
          object={selected.obj}
          initialTab={selected.tab}
          scope={scope}
          onClose={() => setSelected(null)}
          onChanged={() => qc.resetQueries({ queryKey: pagedQueryKey })}
          onOpenPodTerminal={onOpenPodTerminal}
          onOpenPodLogsTerminal={onOpenPodLogsTerminal}
          onOpenDeploymentLogsTerminal={onOpenDeploymentLogsTerminal}
        />
      )}

      {warningDetails && (
        <div className="resource-health-backdrop" onMouseDown={() => setWarningDetails(null)}>
          <section
            className="resource-health-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="resource-health-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="resource-health-dialog-header">
              <div>
                <span className={`resource-health-indicator ${warningDetails.severity}`} aria-hidden="true">
                  {warningDetails.severity === 'error'
                    ? <CircleAlert size={16} aria-hidden="true" />
                    : <TriangleAlert size={16} aria-hidden="true" />}
                </span>
                <h2 id="resource-health-title">
                  {warningDetails.severity === 'error' ? 'Error' : 'Warning'}: {uiText.resource.healthDetailsTitle}
                </h2>
              </div>
              <CloseButton label={uiText.common.close} onClick={() => setWarningDetails(null)} />
            </header>
            <div className="resource-health-dialog-body">
              <p className="resource-health-resource-name">
                {warningDetails.pod.metadata?.namespace
                  ? `${warningDetails.pod.metadata.namespace}/`
                  : ''}{warningDetails.pod.metadata?.name}
              </p>
              <p><strong>{uiText.resource.healthStatusLabel}:</strong> {warningDetails.statusText}</p>
              {warningDetails.reasons.length > 0 && (
                <div className="resource-health-reasons">
                  {warningDetails.reasons.map((reason) => (
                    <p className="resource-health-reason" key={reason}>{reason}</p>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function podRowKey(o: K8sObject): string {
  return o.metadata?.uid ?? `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`;
}

function currentPodHealth(pod: K8sObject): PodHealthDetails | null {
  const status = statusOf('pods', pod);
  if (pod.status?.phase === 'Succeeded' && !pod.metadata?.deletionTimestamp) return null;
  const reasons = new Set<string>();
  let hasCurrentError = status.tone === 'danger';
  if (pod.status?.reason || pod.status?.message) {
    reasons.add([pod.status.reason, pod.status.message].filter(Boolean).join(': '));
  }
  for (const container of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    const state = container.state?.waiting ?? container.state?.terminated;
    if (!state) continue;
    const failedExitCode = typeof state.exitCode === 'number' && state.exitCode !== 0;
    if (state.reason || state.message || failedExitCode) {
      const detail = [state.reason, state.message].filter(Boolean).join(': ') || `Exit code ${state.exitCode}`;
      reasons.add(`${container.name ?? 'Container'}: ${detail}`);
    }
    if (/error|failed|backoff|crashloop/i.test(String(state.reason ?? '')) || failedExitCode) {
      hasCurrentError = true;
    }
  }
  let hasCurrentCondition = false;
  for (const condition of pod.status?.conditions ?? []) {
    if (condition.status === 'True') continue;
    hasCurrentCondition = true;
    const description = [condition.reason, condition.message].filter(Boolean).join(': ');
    reasons.add(`${condition.type ?? 'Condition'}: ${description || condition.status || 'Unknown'}`);
    if (/error|failed|backoff|crashloop/i.test(String(condition.reason ?? ''))) hasCurrentError = true;
  }
  if (status.tone !== 'warn' && !hasCurrentError && !hasCurrentCondition) return null;

  return {
    pod,
    severity: hasCurrentError ? 'error' : 'warning',
    statusText: status.text,
    reasons: [...reasons],
  };
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

function applyWatchEventToPagedCache(
  qc: ReturnType<typeof useQueryClient>,
  queryKey: Array<string | undefined>,
  eventType: string,
  object: K8sObject,
) {
  qc.setQueryData<any>(queryKey, (current: any) => {
    if (!current?.pages || !current.pageParams) return current;
    const key = objectIdentity(object);
    if (!key) return current;

    if (eventType !== 'MODIFIED') return current;

    const pageIndex = current.pages.findIndex((page: PagedResourceListResult) =>
      page.items.some((item) => objectIdentity(item) === key),
    );
    if (pageIndex === -1) return current;

    const pages = current.pages.slice();
    const page = pages[pageIndex] as PagedResourceListResult;
    const itemIndex = page.items.findIndex((item) => objectIdentity(item) === key);
    if (itemIndex === -1) return current;
    const items = page.items.slice();
    items[itemIndex] = object;
    pages[pageIndex] = { ...page, items };
    return { ...current, pages };
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
  const specContainers = [
    ...(Array.isArray(pod.spec?.initContainers) ? pod.spec.initContainers : []),
    ...(Array.isArray(pod.spec?.containers) ? pod.spec.containers : []),
  ] as Array<{ name?: string }>;
  const statuses = [
    ...(Array.isArray(pod.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
    ...(Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []),
  ] as Array<{
    name?: string;
    ready?: boolean;
    restartCount?: number;
    state?: { waiting?: { reason?: string }; running?: unknown; terminated?: { reason?: string } };
  }>;
  const containerNames = new Set(specContainers.map((container) => container.name).filter(Boolean));
  for (const status of statuses) {
    if (status.name && !containerNames.has(status.name)) {
      specContainers.push({ name: status.name });
      containerNames.add(status.name);
    }
  }
  const byName = new Map(statuses.map((status) => [status.name ?? '', status]));

  return specContainers.map((container) => {
    const status = byName.get(container.name ?? '');
    const stateType =
      !status ? 'not-started'
      : status.state?.terminated ? 'terminated'
      : status.ready ? 'ready'
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
