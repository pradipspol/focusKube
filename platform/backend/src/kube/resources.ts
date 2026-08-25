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

interface KubeAccessOptions {
  kubeconfigPath?: string;
  fallbackContext?: string | null;
}

export interface PagedResourceList {
  items: any[];
  continue?: string;
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
  options: KubeAccessOptions & { limit?: number; continue?: string; attributes?: string[] } = {},
): Promise<PagedResourceList> {
  const rk = resolveKind(plural);
  const attributes = options.attributes;
  if (plural !== 'configmaps' && plural !== 'secrets') {
    return { items: await listResource(plural, context, namespace, options) };
  }

  const kubeConfig = await kube.rawConfig(context, options);
  const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const isNamespaced = !!rk.namespaced && !!namespace;
  const _continue = options.continue;
  const limit = options.limit;

  const res = await callK8s(() => {
    if (plural === 'configmaps') {
      return isNamespaced
        ? api.listNamespacedConfigMap(namespace!, undefined, undefined, _continue, undefined, undefined, limit)
        : api.listConfigMapForAllNamespaces(undefined, _continue, undefined, undefined, limit);
    }
    return isNamespaced
      ? api.listNamespacedSecret(namespace!, undefined, undefined, _continue, undefined, undefined, limit)
      : api.listSecretForAllNamespaces(undefined, _continue, undefined, undefined, limit);
  }, { action: 'list', plural: rk.plural, context, namespace: isNamespaced ? namespace : undefined }, {
    timeoutMs: config.k8sListTimeoutMs,
  });

  const body = unwrapBody<any>(res);
  let items = Array.isArray(body.items) ? body.items.map((item: any) => sanitizeListObject(item, plural)) : [];
  if (attributes && attributes.length > 0) {
    items = items.map((item: any) => selectAttributes(item, attributes));
  }
  return { items, continue: body.metadata?.continue || undefined };
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
          { action: 'list', plural: rk.plural, context, namespace: ns },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else if (rk.namespaced) {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('apps/')) {
      const api = kubeConfig.makeApiClient(k8s.AppsV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('batch/')) {
      const api = kubeConfig.makeApiClient(k8s.BatchV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else if (rk.apiVersion.startsWith('networking.k8s.io/')) {
      const api = kubeConfig.makeApiClient(k8s.NetworkingV1Api);
      if (rk.namespaced && ns) {
        res = await callK8s(
          () => (api as any)[`listNamespaced${rk.kind}`](ns),
          { action: 'list', plural: rk.plural, context, namespace: ns },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else if (rk.namespaced) {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}ForAllNamespaces`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      } else {
        res = await callK8s(
          () => (api as any)[`list${rk.kind}`](),
          { action: 'list', plural: rk.plural, context },
          { timeoutMs: config.k8sListTimeoutMs },
        );
      }
    } else {
      const api = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
      res = await callK8s(
        () => api.list(rk.apiVersion, rk.kind, ns),
        { action: 'list', plural: rk.plural, context, namespace: ns },
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
    { action: 'read', plural: rk.plural, context, namespace, name },
  );
  return unwrapBody(res);
}

export async function replaceResource(
  manifest: k8s.KubernetesObject,
  context?: string,
  options: KubeAccessOptions = {},
) {
  const api = await objectApi(context, options);
  const res = await callK8s(() => api.replace(manifest), {
    action: 'replace',
    plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
    context,
    namespace: manifest.metadata?.namespace,
    name: manifest.metadata?.name,
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
): Promise<{ object: any; created: boolean }> {
  const api = await objectApi(context, options);
  try {
    const res = await callK8s(() => api.create(manifest), {
      action: 'create',
      plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
      context,
      namespace: manifest.metadata?.namespace,
      name: manifest.metadata?.name,
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
      }),
    );
    const merged: any = {
      ...(manifest as any),
      metadata: {
        ...(manifest as any).metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    };
    const res = await callK8s(() => api.replace(merged), {
      action: 'replace',
      plural: `${manifest.kind ?? 'unknown'}`.toLowerCase(),
      context,
      namespace: merged.metadata?.namespace,
      name: merged.metadata?.name,
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
) {
  const rk = resolveKind(plural);
  if (rk.namespaced && !namespace) throw badRequest('namespace is required for this resource');
  const api = await objectApi(context, options);
  const res = await callK8s(() =>
    api.delete({
      apiVersion: rk.apiVersion,
      kind: rk.kind,
      metadata: { name, namespace: rk.namespaced ? namespace : undefined },
    } as k8s.KubernetesObject),
    { action: 'delete', plural: rk.plural, context, namespace, name },
  );
  return unwrapBody(res);
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
