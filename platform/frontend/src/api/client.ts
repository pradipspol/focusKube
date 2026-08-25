import type {
  AksCluster,
  AwsIdentity,
  AwsAuthConfig,
  AwsLoginStatus,
  EksCluster,
  AzureAccount,
  AzureAccountGroup,
  AzureLoginStatus,
  AzureSubscription,
  ContextsResponse,
  DeploymentRevision,
  DeviceCodeInfo,
  AuthUser,
  HelmHistoryEntry,
  HelmChart,
  HelmRelease,
  K8sObject,
  PodMetricsBatchResponse,
  LogLevelSettingsResponse,
  LogLevel,
  PodMetricsSnapshot,
  ResourceKindMeta,
} from './types';

/** Which kubeconfig a context/resource call resolves against: local file, Azure cloud, or AWS. */
export type ContextScope = 'local' | 'azure' | 'aws';

export interface Scope {
  context?: string;
  namespace?: string;
  source?: ContextScope;
  attributes?: string;
}

/** Azure-only scope — AWS calls never take a source, they always use the session's AWS files. */
export type AzureScope = 'local' | 'cloud';

const DESKTOP_EMAIL_STORAGE_KEY = 'k8sExplorer.desktopEmail';

export class ApiError extends Error {
  details?: unknown;

  constructor(
    message: string,
    public status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const desktopEmail = typeof window !== 'undefined' ? localStorage.getItem(DESKTOP_EMAIL_STORAGE_KEY) : null;
  const headers = new Headers(init?.headers ?? undefined);
  headers.set('Content-Type', 'application/json');
  if (desktopEmail) {
    headers.set('x-focusKube-email', desktopEmail);
  }
  const res = await fetch(`/api${path}`, {
    headers,
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const body = await res.json();
      message = body.error || message;
      details = body?.details;
      if (body.details) message += `: ${typeof body.details === 'string' ? body.details : JSON.stringify(body.details)}`;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function qs(scope: Scope = {}): string {
  const params = new URLSearchParams();
  if (scope.context) params.set('context', scope.context);
  if (scope.namespace) params.set('namespace', scope.namespace);
  if (scope.source) params.set('source', scope.source);
  if (scope.attributes) params.set('attributes', scope.attributes);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export const api = {
  // Auth
  authConfig: () => request<{ mode: 'desktop' }>('/auth/config'),
  authMe: () => request<{ user: AuthUser | null }>('/auth/me'),
  authSignOut: () => request<{ ok: boolean }>('/auth/signout', { method: 'POST' }),

  // Contexts
  getContexts: () => request<ContextsResponse>('/contexts'),
  setActiveContext: (name: string, source?: ContextScope) =>
    request<{ active: string }>('/contexts/active', {
      method: 'POST',
      body: JSON.stringify({
        name,
        source: source === 'azure' ? 'cloud' : source,
      }),
    }),
  clearActiveContext: () => request<{ active?: string }>('/contexts/disconnect', { method: 'POST' }),
  reloadContexts: () => request<ContextsResponse>('/contexts/reload', { method: 'POST' }),
  uploadLocalKubeconfig: (name: string, content: string) =>
    request<ContextsResponse>('/contexts/local-kubeconfigs', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    }),
  connectLocalKubeconfig: (id: string, contextName?: string) =>
    request<ContextsResponse>(`/contexts/local-kubeconfigs/${id}/connect`, {
      method: 'POST',
      body: JSON.stringify({ contextName }),
    }),
  deleteLocalKubeconfig: (id: string) => request<ContextsResponse>(`/contexts/local-kubeconfigs/${id}`, { method: 'DELETE' }),
  deleteLocalKubeconfigContext: (id: string, contextName: string) =>
    request<ContextsResponse>(
      `/contexts/local-kubeconfigs/${id}/contexts/${encodeURIComponent(contextName)}`,
      { method: 'DELETE' },
    ),

  // Resources
  getKinds: () => request<ResourceKindMeta[]>('/resources/_kinds'),
  applyResourceYaml: (yaml: string, scope: Scope = {}) =>
    request<{ object: K8sObject; created: boolean }>(`/resources/_apply${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  validateResourceYaml: (yaml: string, scope: Scope = {}) =>
    request<{ apiVersion: string; kind: string; name: string; namespace?: string }>(`/resources/_validate${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  listResource: (plural: string, scope: Scope) =>
    request<{ items: K8sObject[] }>(`/resources/${plural}${qs(scope)}`),
  listResourcePage: (plural: string, scope: Scope, page?: { limit?: number; continue?: string }) => {
    const params = new URLSearchParams();
    if (scope.context) params.set('context', scope.context);
    if (scope.namespace) params.set('namespace', scope.namespace);
    if (scope.source) params.set('source', scope.source);
    if (scope.attributes) params.set('attributes', scope.attributes);
    if (page?.limit !== undefined) params.set('limit', String(page.limit));
    if (page?.continue) params.set('continue', page.continue);
    const search = params.toString();
    return request<{ items: K8sObject[]; continue?: string }>(`/resources/${plural}${search ? `?${search}` : ''}`);
  },
  getResourceYaml: (plural: string, name: string, scope: Scope) =>
    request<{ yaml: string }>(`/resources/${plural}/${name}/yaml${qs(scope)}`),
  getResource: (plural: string, name: string, scope: Scope) =>
    request<K8sObject>(`/resources/${plural}/${name}${qs(scope)}`),
  getPodMetrics: (name: string, scope: Scope) =>
    request<PodMetricsSnapshot>(`/resources/pods/${name}/metrics${qs(scope)}`),
  getPodMetricsBatch: (
    pods: Array<string | { name: string; namespace?: string }>,
    scope: Scope,
  ) =>
    request<PodMetricsBatchResponse>(`/resources/pods/metrics/batch${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ pods }),
    }),
  putResourceYaml: (plural: string, name: string, yaml: string, scope: Scope) =>
    request<K8sObject>(`/resources/${plural}/${name}/yaml${qs(scope)}`, {
      method: 'PUT',
      body: JSON.stringify({ yaml }),
    }),
  deleteResource: (plural: string, name: string, scope: Scope) =>
    request<{ ok: boolean }>(`/resources/${plural}/${name}${qs(scope)}`, { method: 'DELETE' }),
  revealSecret: (name: string, scope: Scope) =>
    request<{ name: string; type: string; data: Record<string, string> }>(
      `/resources/secrets/${name}/reveal${qs(scope)}`,
    ),
  putConfigMapData: (name: string, data: Record<string, string>, scope: Scope) =>
    request<K8sObject>(`/resources/configmaps/${name}/data${qs(scope)}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),
  putSecretData: (name: string, data: Record<string, string>, scope: Scope) =>
    request<K8sObject>(`/resources/secrets/${name}/data${qs(scope)}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  // Workload actions
  restartDeployment: (name: string, scope: Scope) =>
    request<K8sObject>(`/workloads/deployments/${name}/restart${qs(scope)}`, { method: 'POST' }),
  scaleDeployment: (name: string, replicas: number, scope: Scope) =>
    request<K8sObject>(`/workloads/deployments/${name}/scale${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ replicas }),
    }),
  deploymentHistory: (name: string, scope: Scope) =>
    request<{ revisions: DeploymentRevision[] }>(`/workloads/deployments/${name}/history${qs(scope)}`),
  rollbackDeployment: (name: string, revision: number | undefined, scope: Scope) =>
    request<{ rolledBackTo: number }>(`/workloads/deployments/${name}/rollback${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),

  // Helm
  helmReleases: (scope: Scope) => request<{ releases: HelmRelease[] }>(`/helm/releases${qs(scope)}`),
  helmAddRepo: (name: string, url: string, scope: Scope) =>
    request<{ ok: boolean; name: string; url: string }>(`/helm/repos${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ name, url }),
    }),
  helmRepos: (scope?: Scope) => request<{ repos: Array<{ name: string; url: string }> }>(`/helm/repos${qs(scope)}`),
  helmCharts: () => request<{ charts: HelmChart[] }>('/helm/charts'),
  helmHistory: (name: string, scope: Scope) =>
    request<{ history: HelmHistoryEntry[] }>(`/helm/releases/${name}/history${qs(scope)}`),
  helmValues: (name: string, scope: Scope) =>
    request<{ values: string }>(`/helm/releases/${name}/values${qs(scope)}`),
  helmRollback: (name: string, revision: number, scope: Scope) =>
    request<{ ok: boolean; output: string }>(`/helm/releases/${name}/rollback${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),
  helmInstall: (req: { chart: string; releaseName: string; namespace: string; values?: string; version?: string }, scope: Scope) =>
    request<{ ok: boolean; output: string }>(`/helm/releases${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  helmUpgrade: (name: string, req: { values?: string; version?: string }, scope: Scope) =>
    request<{ ok: boolean; output: string }>(`/helm/releases/${name}${qs(scope)}`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  helmDiff: (name: string, scope: Scope, revision?: string) => {
    const diffScope = revision ? { ...scope, revision } : scope;
    return request<{ currentManifest: string; comparisonManifest: string }>(`/helm/releases/${name}/diff${qs(diffScope)}`);
  },
  helmChartValues: (chart: string, version?: string) => {
    const params = withQuery('/helm/charts/' + encodeURIComponent(chart) + '/values', { version });
    return request<{ values: string }>(params);
  },
  helmUninstall: (name: string, scope: Scope) =>
    request<{ ok: boolean }>(`/helm/releases/${name}${qs(scope)}`, { method: 'DELETE' }),

  // Azure
  azureAccount: (source?: AzureScope) =>
    request<{ account: AzureAccount | null }>(withQuery('/azure/account', { source })),
  azureAccounts: (source?: AzureScope) =>
    request<{ accounts: AzureAccountGroup[] }>(withQuery('/azure/accounts', { source })),
  azureLogin: (source?: AzureScope) =>
    request<DeviceCodeInfo>(withQuery('/azure/login', { source }), { method: 'POST' }),
  azureLoginStatus: (source?: AzureScope) =>
    request<AzureLoginStatus>(withQuery('/azure/login/status', { source })),
  azureLogout: (username?: string, source?: AzureScope) =>
    request<{ ok: boolean }>(withQuery('/azure/logout', { source }), {
      method: 'POST',
      body: JSON.stringify({ ...(username ? { username } : {}), ...(source ? { source } : {}) }),
    }),
  azureDisconnectAccount: (email: string) =>
    request<{ ok: boolean; removed: string[] }>('/azure/accounts/disconnect', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  azureSubscriptions: (source?: AzureScope) =>
    request<{ subscriptions: AzureSubscription[] }>(withQuery('/azure/subscriptions', { source })),
  azureSetSubscription: (id: string, source?: AzureScope) =>
    request<{ ok: boolean }>(withQuery('/azure/subscription', { source }), {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  azureAks: (subscription?: string, source?: AzureScope) =>
    request<{ clusters: AksCluster[] }>(withQuery('/azure/aks', { subscription, source })),
  azureAksCredentials: (body: { resourceGroup: string; name: string; subscription?: string; admin?: boolean }) =>
    request<ContextsResponse>('/azure/aks/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // App settings
  getLogLevel: () => request<LogLevelSettingsResponse>('/settings/log-level'),
  setLogLevel: (level: LogLevel) =>
    request<{ ok: boolean; level: LogLevel }>('/settings/log-level', {
      method: 'POST',
      body: JSON.stringify({ level }),
    }),

  // AWS
  awsAccount: () => request<{ account: AwsIdentity | null }>('/aws/account'),
  awsLogin: () => request<DeviceCodeInfo>('/aws/login', { method: 'POST' }),
  awsLoginStatus: () => request<AwsLoginStatus>('/aws/login/status'),
  awsLogout: () => request<{ ok: boolean }>('/aws/logout', { method: 'POST' }),
  awsConfigureAuth: (body: AwsAuthConfig) =>
    request<{ ok: boolean; profileName: string; mode: AwsAuthConfig['mode'] }>('/aws/configure-auth', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  awsEks: () => request<{ clusters: EksCluster[]; error?: string }>('/aws/eks'),
  awsEksCredentials: (body: { region: string; name: string }) =>
    request<ContextsResponse>('/aws/eks/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Observability — time-travel debugging, event timeline, log aggregation
  observabilityStatus: (scope: Scope) =>
    request<any>(withQuery('/observability/status', { context: scope.context })),
  observabilityStartRecording: (scope: Scope) =>
    request<any>('/observability/recordings/start', { method: 'POST', body: JSON.stringify({ context: scope.context }) }),
  observabilityStopRecording: (scope: Scope) =>
    request<any>('/observability/recordings/stop', { method: 'POST', body: JSON.stringify({ context: scope.context }) }),
  observabilityEvents: (scope: Scope, params: { from?: Date; to?: Date; namespace?: string; category?: string; severity?: string }) =>
    request<any>(
      withQuery('/observability/events', { context: scope.context, from: params.from?.toISOString(), to: params.to?.toISOString(), namespace: params.namespace, category: params.category, severity: params.severity }),
    ),
  observabilityStateAt: (scope: Scope, atTime: Date, namespace?: string) =>
    request<any>(
      withQuery('/observability/state-at', { context: scope.context, timestamp: atTime.toISOString(), namespace }),
    ),
  observabilityCorrelation: (scope: Scope, params: { from?: Date; to?: Date }) =>
    request<any>(
      withQuery('/observability/correlation', { context: scope.context, from: params.from?.toISOString(), to: params.to?.toISOString() }),
    ),
};

export function getDesktopEmail(): string {
  return localStorage.getItem(DESKTOP_EMAIL_STORAGE_KEY) ?? '';
}

export function setDesktopEmail(email: string): void {
  localStorage.setItem(DESKTOP_EMAIL_STORAGE_KEY, email.trim().toLowerCase());
}

export function clearDesktopEmail(): void {
  localStorage.removeItem(DESKTOP_EMAIL_STORAGE_KEY);
}

/** Build a WebSocket URL for logs/exec via the same origin (proxied in dev). */
export function wsUrl(path: string, params: Record<string, string | undefined>): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const search = new URLSearchParams();
  const desktopEmail = typeof window !== 'undefined' ? localStorage.getItem(DESKTOP_EMAIL_STORAGE_KEY) : null;
  if (desktopEmail) search.set('email', desktopEmail);
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  return `${proto}://${window.location.host}${path}?${search.toString()}`;
}

