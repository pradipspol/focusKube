import * as k8s from '@kubernetes/client-node';
import { kube } from './client.js';
import { config } from '../config.js';
import { callK8s } from '../util/k8sError.js';
import { HttpError, badRequest, notFound } from '../util/httpError.js';
import { logInfo, logError } from '../util/logger.js';

export interface ResourceKind {
  /** URL segment, e.g. "deployments". */
  plural: string;
  apiVersion: string;
  kind: string;
  namespaced: boolean;
}

export interface KubeAccessOptions {
  kubeconfigPath?: string;
  fallbackContext?: string | null;
  azureConfigDir?: string;
}

export interface PagedResourceList {
  items: any[];
  continue?: string;
  resourceVersion?: string;
  remainingItemCount?: number;
}

/** Registry of resource kinds the explorer can browse generically. */
export const RESOURCE_KINDS: Record<string, ResourceKind> = {
  namespaces: { plural: 'namespaces', apiVersion: 'v1', kind: 'Namespace', namespaced: false },
  nodes: { plural: 'nodes', apiVersion: 'v1', kind: 'Node', namespaced: false },
  events: { plural: 'events', apiVersion: 'v1', kind: 'Event', namespaced: true },
  pods: { plural: 'pods', apiVersion: 'v1', kind: 'Pod', namespaced: true },
  services: { plural: 'services', apiVersion: 'v1', kind: 'Service', namespaced: true },
  endpoints: { plural: 'endpoints', apiVersion: 'v1', kind: 'Endpoints', namespaced: true },
  configmaps: { plural: 'configmaps', apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
  secrets: { plural: 'secrets', apiVersion: 'v1', kind: 'Secret', namespaced: true },
  resourcequotas: { plural: 'resourcequotas', apiVersion: 'v1', kind: 'ResourceQuota', namespaced: true },
  limitranges: { plural: 'limitranges', apiVersion: 'v1', kind: 'LimitRange', namespaced: true },
  serviceaccounts: { plural: 'serviceaccounts', apiVersion: 'v1', kind: 'ServiceAccount', namespaced: true },
  persistentvolumeclaims: {
    plural: 'persistentvolumeclaims',
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    namespaced: true,
  },
  deployments: { plural: 'deployments', apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
  statefulsets: { plural: 'statefulsets', apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true },
  daemonsets: { plural: 'daemonsets', apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true },
  replicasets: { plural: 'replicasets', apiVersion: 'apps/v1', kind: 'ReplicaSet', namespaced: true },
  horizontalpodautoscalers: {
    plural: 'horizontalpodautoscalers',
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    namespaced: true,
  },
  jobs: { plural: 'jobs', apiVersion: 'batch/v1', kind: 'Job', namespaced: true },
  cronjobs: { plural: 'cronjobs', apiVersion: 'batch/v1', kind: 'CronJob', namespaced: true },
  poddisruptionbudgets: {
    plural: 'poddisruptionbudgets',
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    namespaced: true,
  },
  leases: { plural: 'leases', apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', namespaced: true },
  ingresses: { plural: 'ingresses', apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', namespaced: true },
  ingressclasses: {
    plural: 'ingressclasses',
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IngressClass',
    namespaced: false,
  },
  networkpolicies: {
    plural: 'networkpolicies',
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    namespaced: true,
  },
  endpointslices: {
    plural: 'endpointslices',
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    namespaced: true,
  },
  roles: { plural: 'roles', apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', namespaced: true },
  rolebindings: {
    plural: 'rolebindings',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    namespaced: true,
  },
  storageclasses: {
    plural: 'storageclasses',
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    namespaced: false,
  },
  customresourcedefinitions: {
    plural: 'customresourcedefinitions',
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    namespaced: false,
  },
};

export function resolveKind(plural: string): ResourceKind {
  const kind = RESOURCE_KINDS[plural];
  if (!kind) throw notFound(`Unknown resource type: ${plural}`);
  return kind;
}

export function resourceWatchPath(plural: string, namespace?: string): string {
  const rk = resolveKind(plural);
  const base = rk.apiVersion === 'v1' ? `/api/${rk.apiVersion}` : `/apis/${rk.apiVersion}`;
  if (rk.namespaced && namespace) return `${base}/namespaces/${namespace}/${rk.plural}`;
  return `${base}/${rk.plural}`;
}

async function objectApi(contextName?: string, options: KubeAccessOptions = {}): Promise<k8s.KubernetesObjectApi> {
  logInfo('objectApi.start', { contextName });
  try {
    const kubeConfig = await kube.rawConfig(contextName, options);
    logInfo('objectApi.rawConfig.complete', { contextName });
    const api = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
    logInfo('objectApi.makeApiClient.complete', { contextName });
    return api;
  } catch (err) {
    logError('objectApi.error', { contextName, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function unwrapBody<T = any>(value: any): T {
  return (value?.body ?? value) as T;
}

export async function listResourcePage(
  plural: string,
  context?: string,
  namespace?: string,
  options: KubeAccessOptions & {
    limit?: number;
    continue?: string;
    attributes?: string[];
  } = {},
): Promise<PagedResourceList> {
  const rk = resolveKind(plural);
  const kubeConfig = await kube.rawConfig(context, options);
  const api = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
  const isNamespaced = !!rk.namespaced && !!namespace;
  const res = await callK8s(
    () => api.list(
      rk.apiVersion,
      rk.kind,
      isNamespaced ? namespace : undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options.limit,
      options.continue,
    ),
    { action: 'list', plural: rk.plural, context, namespace: isNamespaced ? namespace : undefined, azureConfigDir: options.azureConfigDir }, {
    timeoutMs: config.k8sListTimeoutMs,
  });

  const body = unwrapBody<any>(res);
  let items = Array.isArray(body.items) ? body.items : [];
  if (plural === 'configmaps' || plural === 'secrets') {
    items = items.map((item: any) => sanitizeListObject(item, plural));
  }
  const attributes = options.attributes;
  if (attributes && attributes.length > 0) {
    items = items.map((item: any) => selectAttributes(item, attributes));
  }
  return {
    items,
    continue: body.metadata?._continue ?? body.metadata?.continue ?? undefined,
    resourceVersion: body.metadata?.resourceVersion || undefined,
    remainingItemCount: typeof body.metadata?.remainingItemCount === 'number'
      ? body.metadata.remainingItemCount
      : undefined,
  };
}

function selectAttributes(item: any, attributes: string[]): any {
  const selected: any = {};

  for (const attr of attributes) {
    if (attr === 'name' && item.metadata?.name) {
      selected.name = item.metadata.name;
    } else if (attr === 'namespace' && item.metadata?.namespace) {
      selected.namespace = item.metadata.namespace;
    } else if (attr === 'uid' && item.metadata?.uid) {
      selected.uid = item.metadata.uid;
    } else if (attr === 'creationTimestamp' && item.metadata?.creationTimestamp) {
      selected.creationTimestamp = item.metadata.creationTimestamp;
    } else if (attr === 'labels' && item.metadata?.labels) {
      selected.labels = item.metadata.labels;
    } else if (attr === 'annotations' && item.metadata?.annotations) {
      selected.annotations = item.metadata.annotations;
    } else if (attr === 'status' && item.status) {
      selected.status = item.status;
    } else if (attr === 'kind' && item.kind) {
      selected.kind = item.kind;
    } else if (attr === 'apiVersion' && item.apiVersion) {
      selected.apiVersion = item.apiVersion;
    }
  }

  return selected;
}

export async function listResource(
  plural: string,
  context?: string,
  namespace?: string,
  options: KubeAccessOptions & { attributes?: string[] } = {},
) {
  const startTime = Date.now();
  const attributes = options.attributes;

  try {
    logInfo('kube.resource.list.start', {
      plural,
      context,
      namespace,
      attributes: attributes?.length ?? 0,
      elapsed: 0,
    });

    const rk = resolveKind(plural);
    logInfo('kube.resource.list.resolve_kind', {
      plural,
      context,
      namespace,
      kind: rk.kind,
      apiVersion: rk.apiVersion,
      elapsed: Date.now() - startTime,
    });

    const kubeConfig = await kube.rawConfig(context, options);
    logInfo('kube.resource.list.config_loaded', {
      plural,
      context,
      namespace,
      elapsed: Date.now() - startTime,
    });

    const ns = rk.namespaced ? namespace : undefined;
    logInfo('kube.resource.list.callk8s_start', {
      plural,
      context,
      namespace: ns,
      elapsed: Date.now() - startTime,
    });

    // Use the appropriate typed API based on apiVersion
    let res: any;
    if (rk.apiVersion === 'v1') {
      const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else if (rk.namespaced) {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('apps/')) {
      const api = kubeConfig.makeApiClient(k8s.AppsV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('batch/')) {
      const api = kubeConfig.makeApiClient(k8s.BatchV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('networking.k8s.io/')) {
      const api = kubeConfig.makeApiClient(k8s.NetworkingV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else if (rk.namespaced) {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}`](),
          { action: 'list', plural: rk.plural, context, azureConfigDir: options.azureConfigDir },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else {
      const api = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
      res = await callK8s(
        () => api.list(rk.apiVersion, rk.kind, ns),
        { action: 'list', plural: rk.plural, context, namespace: ns, azureConfigDir: options.azureConfigDir },
        { timeoutMs: config.k8sListTimeoutMs },
      );
    }

    logInfo('kube.resource.list.callk8s_complete', {
      plural,
      context,
      namespace: ns,
      elapsed: Date.now() - startTime,
    });

    let items = unwrapBody<any>(res).items ?? [];
    logInfo('kube.resource.list.items_extracted', {
      plural,
      context,
      namespace,
      itemCount: items.length,
      elapsed: Date.now() - startTime,
    });

    if (plural !== 'configmaps' && plural !== 'secrets') {
      logInfo('kube.resource.list.filtering_check', {
        plural,
        hasAttributes: !!attributes,
        attributesLength: attributes?.length ?? 0,
        attributes: attributes,
        itemsBeforeFilter: items.length,
        firstItemKeys: items[0] ? Object.keys(items[0]) : [],
        elapsed: Date.now() - startTime,
      });
      if (attributes && attributes.length > 0) {
        const filtered = items.map((item: any) => {
          const result = selectAttributes(item, attributes);
          return result;
        });
        logInfo('kube.resource.list.filtered', {
          plural,
          itemCount: filtered.length,
          firstFilteredItemKeys: filtered[0] ? Object.keys(filtered[0]) : [],
          firstFilteredItem: filtered[0],
          elapsed: Date.now() - startTime,
        });
        items = filtered;
      }
      logInfo('kube.resource.list.complete', {
        plural,
        context,
        namespace,
        itemCount: items.length,
        elapsed: Date.now() - startTime,
      });
      return items;
    }

    const sanitized = items.map((item: any) => sanitizeListObject(item, plural));
    logInfo('kube.resource.list.complete', {
      plural,
      context,
      namespace,
      itemCount: sanitized.length,
      sanitized: true,
      elapsed: Date.now() - startTime,
    });
    return sanitized;
  } catch (err) {
    logError('kube.resource.list.error', {
      plural,
      context,
      namespace,
      error: (err as Error).message,
      elapsed: Date.now() - startTime,
    });
    throw err;
  }
}

export async function getResource(
  plural: string,
  name: string,
  context?: string,
  namespace?: string,
  options: KubeAccessOptions = {},
) {
  const rk = resolveKind(plural);
  if (rk.namespaced && !namespace) throw badRequest('namespace is required for this resource');
  const api = await objectApi(context, options);
  const res = await callK8s(() =>
    api.read({
      apiVersion: rk.apiVersion,
      kind: rk.kind,
      metadata: { name, namespace: rk.namespaced ? namespace : undefined },
    }),
    { action: 'read', plural: rk.plural, context, namespace, name, azureConfigDir: options.azureConfigDir },
  );
  return unwrapBody(res);
}

export async function replaceResource(
  manifest: k8s.KubernetesObject,
  context?: string,
  options: KubeAccessOptions = {},
  dryRun?: boolean,
) {
  const api = await objectApi(context, options);
  const res = await callK8s(() => api.replace(manifest, undefined, dryRun ? 'All' : undefined), {
    action: 'replace',
    plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
    context,
    namespace: manifest.metadata?.namespace,
    name: manifest.metadata?.name,
    azureConfigDir: options.azureConfigDir,
  });
  return unwrapBody(res);
}

/**
 * Create a manifest of any kind, or update it in place when it already exists
 * (the equivalent of `kubectl apply`). Works for any Kubernetes object since
 * KubernetesObjectApi resolves the right API from apiVersion/kind.
 */
export async function applyManifest(
  manifest: k8s.KubernetesObject,
  context?: string,
  options: KubeAccessOptions = {},
  dryRun = false,
): Promise<{ object: any; created: boolean }> {
  const api = await objectApi(context, options);
  try {
    const res = await callK8s(() => api.create(manifest, undefined, dryRun ? 'All' : undefined), {
      action: 'create',
      plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
      context,
      namespace: manifest.metadata?.namespace,
      name: manifest.metadata?.name,
      azureConfigDir: options.azureConfigDir,
    });
    return { object: unwrapBody(res), created: true };
  } catch (err) {
    // Already exists → replace it, carrying over the current resourceVersion.
    if (!(err instanceof HttpError) || err.status !== 409) throw err;
    const existing = unwrapBody<any>(
      await callK8s(() => api.read(manifest as any), {
        action: 'read',
        plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
        context,
        namespace: manifest.metadata?.namespace,
        name: manifest.metadata?.name,
        azureConfigDir: options.azureConfigDir,
      }),
    );
    const merged: any = {
      ...(manifest as any),
      metadata: {
        ...(manifest as any).metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    };
    const res = await callK8s(() => api.replace(merged, undefined, dryRun ? 'All' : undefined), {
      action: 'replace',
      plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
      context,
      namespace: merged.metadata?.namespace,
      name: merged.metadata?.name,
      azureConfigDir: options.azureConfigDir,
    });
    return { object: unwrapBody(res), created: false };
  }
}

export async function deleteResource(
  plural: string,
  name: string,
  context?: string,
  namespace?: string,
  options: KubeAccessOptions = {},
  dryRun = false,
) {
  const rk = resolveKind(plural);
  if (rk.namespaced && !namespace) throw badRequest('namespace is required for this resource');
  const api = await objectApi(context, options);
  const res = await callK8s(() =>
    api.delete({
      apiVersion: rk.apiVersion,
      kind: rk.kind,
      metadata: { name, namespace: rk.namespaced ? namespace : undefined },
    } as k8s.KubernetesObject, undefined, dryRun ? 'All' : undefined),
    { action: 'delete', plural: rk.plural, context, namespace, name, azureConfigDir: options.azureConfigDir },
  );
  return unwrapBody(res);
}

/** Strips the two fields that inflate a manifest's size without telling a reader anything
 * useful: `metadata.managedFields` (field-ownership bookkeeping Kubernetes attaches on every
 * write — routinely several KB on its own, confirmed against a real cluster) and the
 * `kubectl.kubernetes.io/last-applied-configuration` annotation (a full copy of the prior
 * manifest, stamped by every `kubectl apply`). Unlike sanitizeForEdit, keeps `status`,
 * `creationTimestamp`, and `generation` — this is for a read tool result to show/summarize,
 * not for re-submitting as an edit. */
export function stripReadNoise<T extends k8s.KubernetesObject>(obj: T): T {
  const clone: any = JSON.parse(JSON.stringify(obj));
  if (clone.metadata) {
    delete clone.metadata.managedFields;
    if (clone.metadata.annotations) {
      delete clone.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    }
  }
  return clone;
}

/** Strip server-managed fields so an object is clean to re-apply. */
export function sanitizeForEdit<T extends k8s.KubernetesObject>(obj: T): T {
  const clone: any = JSON.parse(JSON.stringify(obj));
  if (clone.metadata) {
    delete clone.metadata.managedFields;
    delete clone.metadata.creationTimestamp;
    delete clone.metadata.generation;
    if (clone.metadata.annotations) {
      delete clone.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    }
  }
  delete clone.status;
  return clone;
}

/** Whether a Pod's labels satisfy a Deployment/ReplicaSet-style LabelSelector (`matchLabels` +
 * `matchExpressions`). Shared by ws/streams.ts's log streaming and kube/podLogsOnce.ts's
 * one-shot log fetch for the AI assistant's get_logs tool. */
export function matchesDeploymentSelector(selector: any, podLabels: Record<string, unknown>): boolean {
  const matchLabels = selector?.matchLabels ?? {};
  const matchExpressions = Array.isArray(selector?.matchExpressions) ? selector.matchExpressions : [];

  const labelsMatch = Object.entries(matchLabels).every(([key, value]) => podLabels[key] === String(value));
  if (!labelsMatch) return false;

  return matchExpressions.every((expression: any) => {
    const key = String(expression?.key ?? '');
    const values = Array.isArray(expression?.values) ? expression.values.map((value: unknown) => String(value)) : [];
    const labelValue = podLabels[key];
    switch (expression?.operator) {
      case 'In':
        return labelValue !== undefined && values.includes(String(labelValue));
      case 'NotIn':
        return labelValue === undefined || !values.includes(String(labelValue));
      case 'Exists':
        return labelValue !== undefined;
      case 'DoesNotExist':
        return labelValue === undefined;
      default:
        return false;
    }
  });
}

const SENSITIVE_PLURALS = new Set(['secrets', 'configmaps']);

/** Redacts a single Secret/ConfigMap down to metadata + key names only (no values) — the
 * same reduction `listResource()` already applies to list results, reused here for callers
 * that fetch ONE resource by name via `getResource()`/`applyManifest()`, which apply no
 * redaction of their own. The AI assistant's tools (aiToolExecutor.ts, aiContextService.ts)
 * must call this before putting a fetched object into a tool result or approval-card diff —
 * that content is rendered in chat AND re-sent to the LLM on every subsequent turn, which is
 * a materially different exposure than the human-only resource browser (whose own secret
 * value reveal is a separate, explicit, config.allowSecretReveal-gated action). No-op for any
 * other kind. */
export function redactIfSensitive(obj: any, plural: string): any {
  return SENSITIVE_PLURALS.has(plural) ? sanitizeListObject(obj, plural) : obj;
}

function sanitizeListObject(obj: any, plural: string): any {
  const clone: any = {
    apiVersion: obj.apiVersion,
    kind: obj.kind,
    metadata: obj.metadata ? JSON.parse(JSON.stringify(obj.metadata)) : undefined,
  };

  if (obj.status !== undefined) {
    clone.status = obj.status;
  }

  const dataKeys = new Set<string>();
  if (obj.data && typeof obj.data === 'object') {
    for (const key of Object.keys(obj.data)) dataKeys.add(key);
  }
  if (obj.binaryData && typeof obj.binaryData === 'object') {
    for (const key of Object.keys(obj.binaryData)) dataKeys.add(key);
  }
  if (obj.stringData && typeof obj.stringData === 'object') {
    for (const key of Object.keys(obj.stringData)) dataKeys.add(key);
  }

  if (plural === 'configmaps') {
    clone.dataKeys = Array.from(dataKeys);
  } else if (plural === 'secrets') {
    clone.dataKeys = Array.from(dataKeys);
    clone.type = obj.type;
  }

  return clone;
}
