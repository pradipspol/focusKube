import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import { z } from 'zod';
import { kube } from '../kube/client.js';
import {
  RESOURCE_KINDS,
  applyManifest,
  deleteResource,
  getResource,
  listResource,
  listResourcePage,
  replaceResource,
  resolveKind,
  sanitizeForEdit,
} from '../kube/resources.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { callK8s } from '../util/k8sError.js';
import { badRequest, HttpError } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { config } from '../config.js';
import {
  azureConfigDirForSource,
  kubeconfigPathForSource,
  resolveSessionScopeForContext,
  type SessionScope,
} from '../auth/session.js';
import { setRequestOperation } from '../util/requestOp.js';
import { logDebug, logError, logInfo } from '../util/logger.js';

export const resourcesRouter = Router();
const POD_METRICS_BATCH_CONCURRENCY = 10;

const ctx = (req: any) => (req.query.context as string) || req.userSession.activeContext || undefined;
const ns = (req: any) => (req.query.namespace as string) || undefined;
const requestedSource = (req: any) => (req.query.source as string) || undefined;
const kubeOpts = (req: any, kubeconfigPath: string) => ({
  kubeconfigPath,
  fallbackContext: req.userSession.activeContext,
});

function wrapInteractiveAzureAuthError(err: unknown, source: SessionScope): never {
  if (err instanceof HttpError && err.status === 401) {
    throw err;
  }
  if (err instanceof Error) {
    const msg = err.message || '';
    const looksLikeDeviceCodePrompt =
      /login\.microsoft\.com\/device/i.test(msg) ||
      /to sign in, use a web browser/i.test(msg) ||
      /device\s*code/i.test(msg);
    if (looksLikeDeviceCodePrompt) {
      throw new HttpError(401, 'Azure authentication is required for this context. Please sign in from the Azure panel.', {
        code: 'AZURE_AUTH_REQUIRED',
        source,
      });
    }
  }
  throw err;
}

async function maybeWrapAbortAsAzureAuthRequired(
  err: unknown,
  source: SessionScope,
  kubeconfigPath: string,
): Promise<never> {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const abortedLike = lower === 'aborted' || lower.includes('econnreset') || lower.includes('http request failed');
  if (!abortedLike) {
    throw err;
  }

  try {
    const content = await fsp.readFile(kubeconfigPath, 'utf8');
    const hasDeviceCodeLogin =
      /(\n\s*-\s*['"]--login['"]\s*\n\s*-\s*)devicecode\b/i.test(content) ||
      /['"]--login['"]\s*,\s*['"]devicecode['"]/i.test(content);
    if (hasDeviceCodeLogin) {
      throw new HttpError(401, 'Azure authentication is required for this context. Please sign in from the Azure panel.', {
        code: 'AZURE_AUTH_REQUIRED',
        source,
      });
    }
  } catch (readErr) {
    if (readErr instanceof HttpError) throw readErr;
    // Ignore read failures and keep original error path.
  }

  throw err;
}

/** Available resource kinds (for building the sidebar). */
resourcesRouter.get('/_kinds', withRouteErrorLogging('resources', 'GET /_kinds', (_req, res) => {
  setRequestOperation(_req, 'resources.kinds.list');
  res.json(Object.values(RESOURCE_KINDS));
}));

/** Create (or update) any resource from a raw YAML manifest — like `kubectl apply`. */
resourcesRouter.post('/_apply', withRouteErrorLogging('resources', 'POST /_apply', async (req, res) => {
  setRequestOperation(req, 'resources.apply');
  const body = z.object({ yaml: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('yaml is required');

  let manifest: any;
  try {
    manifest = yaml.load(body.data.yaml);
  } catch (err) {
    throw badRequest('Invalid YAML', (err as Error).message);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw badRequest('YAML must be a single Kubernetes object');
  }
  if (!manifest.apiVersion || !manifest.kind || !manifest.metadata?.name) {
    throw badRequest('YAML must include apiVersion, kind and metadata.name');
  }
  // Default the namespace from the active scope when the manifest omits one.
  if (!manifest.metadata.namespace) {
    const queryNs = ns(req);
    if (queryNs) manifest.metadata.namespace = queryNs;
  }

  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);

  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });

  const { object, created } = await applyManifest(manifest, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.status(created ? 201 : 200).json({ object, created });
}));

resourcesRouter.get('/pods/:name/metrics', withRouteErrorLogging('resources', 'GET /pods/:name/metrics', async (req, res) => {
  setRequestOperation(req, 'resources.pod.metrics');
  const namespace = ns(req);
  if (!namespace) throw badRequest('namespace query parameter is required');
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);

  logInfo('resources.scope.selected', {
    reqId: req.logRequestId ?? null,
    operation: 'resources.pod.metrics',
    context: requestedContext,
    resolvedScope: selectedScope,
    activeContext: req.userSession.activeContext,
    activeContextSource: req.userSession.activeContextSource,
    kubeconfigPath: selectedKubeconfigPath,
    azureConfigDir: selectedAzureConfigDir,
  });

  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });

  const api = (await kube.rawConfig(requestedContext, kubeOpts(req, selectedKubeconfigPath))).makeApiClient(k8s.CustomObjectsApi);
  const metricsRes = await callK8s(() =>
    api.getNamespacedCustomObject('metrics.k8s.io', 'v1beta1', namespace, 'pods', req.params.name),
  );
  res.json(buildPodMetricsSnapshot((metricsRes as any).body ?? metricsRes));
}));

resourcesRouter.post('/pods/metrics/batch', withRouteErrorLogging('resources', 'POST /pods/metrics/batch', async (req, res) => {
  setRequestOperation(req, 'resources.pod.metrics.batch');
  const body = z
    .object({
      pods: z
        .array(
          z.union([
            z.string().min(1),
            z.object({
              name: z.string().min(1),
              namespace: z.string().min(1).optional(),
            }),
          ]),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) throw badRequest('pods is required and must be a non-empty array');

  const defaultNamespace = ns(req);
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);

  logInfo('resources.scope.selected', {
    reqId: req.logRequestId ?? null,
    operation: 'resources.pod.metrics.batch',
    context: requestedContext,
    resolvedScope: selectedScope,
    activeContext: req.userSession.activeContext,
    activeContextSource: req.userSession.activeContextSource,
    kubeconfigPath: selectedKubeconfigPath,
    azureConfigDir: selectedAzureConfigDir,
  });

  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });

  const api = (await kube.rawConfig(requestedContext, kubeOpts(req, selectedKubeconfigPath))).makeApiClient(k8s.CustomObjectsApi);
  const pods = body.data.pods.map((pod) => {
    if (typeof pod === 'string') {
      return { name: pod, namespace: defaultNamespace };
    }
    return { name: pod.name, namespace: pod.namespace ?? defaultNamespace };
  });

  if (pods.some((pod) => !pod.namespace)) {
    throw badRequest('namespace query parameter is required when any pod item omits namespace');
  }

  const uniquePods = Array.from(
    new Map(pods.map((pod) => [`${pod.namespace}/${pod.name}`, pod] as const)).values(),
  );

  const items: Array<{ name: string; namespace?: string; snapshot?: any; error?: string }> = [];
  // Process in bounded batches to avoid hammering metrics-server on large pod lists.
  for (let i = 0; i < uniquePods.length; i += POD_METRICS_BATCH_CONCURRENCY) {
    const chunk = uniquePods.slice(i, i + POD_METRICS_BATCH_CONCURRENCY);
    const chunkItems = await Promise.all(
      chunk.map(async (pod) => {
        try {
          const metricsRes = await callK8s(() =>
            api.getNamespacedCustomObject('metrics.k8s.io', 'v1beta1', pod.namespace!, 'pods', pod.name),
          );
          return {
            name: pod.name,
            namespace: pod.namespace,
            snapshot: buildPodMetricsSnapshot((metricsRes as any).body ?? metricsRes),
          };
        } catch (err) {
          return {
            name: pod.name,
            namespace: pod.namespace,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    items.push(...chunkItems);
  }

  res.json({ items });
}));

resourcesRouter.get('/:plural', async (req, res) => {
  setRequestOperation(req, 'resources.list');
  const reqId = (req as any).id;
  const plural = req.params.plural;
  const namespace = ns(req);

  const logDbg = (stage: string, details?: any) => {
    logDebug(stage, {
      reqId,
      operation: 'resources.list',
      stage,
      plural,
      namespace,
      ...details,
    })
  };

  const logErr = (stage: string, details?: any) => {
    logError(stage, {
      reqId,
      operation: 'resources.list',
      stage,
      plural,
      namespace,
      ...details,
    })
  };
  // };

  logDbg('resources.list.start');

  try {
    const requestedContext = ctx(req);
    const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
    const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
    const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
    logInfo('resources.scope.selected', {
      reqId,
      operation: 'resources.list',
      context: requestedContext,
      resolvedScope: selectedScope,
      activeContext: req.userSession.activeContext,
      activeContextSource: req.userSession.activeContextSource,
      kubeconfigPath: selectedKubeconfigPath,
      azureConfigDir: selectedAzureConfigDir,
    });

    logDbg('auth.ensure_context.start');
    await ensureContextAuthReady({
      context: requestedContext,
      kubeconfigPath: selectedKubeconfigPath,
      fallbackContext: req.userSession.activeContext,
      azureConfigDir: selectedAzureConfigDir,
      source: selectedScope,
      userId: req.authUser?.id,
        azureLogin: req.userSession.azureLogin,
    });
    logDbg('auth.ensure_context.complete');
  } catch (err) {
    logErr('auth.ensure_context.error', { error: (err as Error).message });
    throw err;
  }

  const rawLimit = req.query.limit as string | undefined;
  const rawContinue = req.query.continue as string | undefined;
  const rawAttributes = req.query.attributes as string | undefined;
  const attributes = rawAttributes ? rawAttributes.split(',').map(a => a.trim()).filter(a => a) : undefined;
  logDbg('attributes_parsed', { rawAttributes, attributes, hasAttributes: !!attributes });

  const context = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, context, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);

  if (rawLimit || rawContinue) {
    logDbg('list.paginated.start', { limit: rawLimit, continue: rawContinue });
    const limit = rawLimit ? Math.max(1, Math.min(250, Number(rawLimit))) : undefined;
    const options = { ...kubeOpts(req, selectedKubeconfigPath), attributes };

    let page;
    try {
      page = await listResourcePage(req.params.plural, context, ns(req), options);
    } catch (err) {
      await maybeWrapAbortAsAzureAuthRequired(err, selectedScope, selectedKubeconfigPath);
      wrapInteractiveAzureAuthError(err, selectedScope);
    }
    logDbg('list.paginated.complete');
    res.json(page);
    return;
  }

  logDbg('list.all.start');
  const options = { ...kubeOpts(req, selectedKubeconfigPath), attributes };
  logDbg('list.all.params_resolved', { plural, context, namespace });

  logDbg('list.all.calling_listResource');
  let items: any[];
  try {
    items = await listResource(plural, context, namespace, options);
  } catch (err) {
    await maybeWrapAbortAsAzureAuthRequired(err, selectedScope, selectedKubeconfigPath);
    wrapInteractiveAzureAuthError(err, selectedScope);
  }
  logDbg('list.all.listResource_returned');
  logDbg('list.all.complete', { itemCount: items.length });
  res.json({ items });
});

resourcesRouter.get('/:plural/:name', async (req, res) => {
  setRequestOperation(req, 'resources.get');
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
      azureLogin: req.userSession.azureLogin,
  });
  const obj = await getResource(req.params.plural, req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  res.json(obj);
});

resourcesRouter.get('/:plural/:name/yaml', async (req, res) => {
  setRequestOperation(req, 'resources.yaml.get');
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
      azureLogin: req.userSession.azureLogin,
  });
  const obj = await getResource(req.params.plural, req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  res.json({ yaml: yaml.dump(sanitizeForEdit(obj as any)) });
});

resourcesRouter.put('/:plural/:name/yaml', async (req, res) => {
  setRequestOperation(req, 'resources.yaml.replace');
  const body = z.object({ yaml: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('yaml is required');

  let manifest: any;
  try {
    manifest = yaml.load(body.data.yaml);
  } catch (err) {
    throw badRequest('Invalid YAML', (err as Error).message);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.kind || !manifest.metadata?.name) {
    throw badRequest('YAML must be a single Kubernetes object with kind and metadata.name');
  }
  // Ensure the edit targets the same object referenced in the URL.
  const rk = resolveKind(req.params.plural);
  if (manifest.kind !== rk.kind) {
    throw badRequest(`YAML kind "${manifest.kind}" does not match "${rk.kind}"`);
  }
  if (manifest.metadata.name !== req.params.name) {
    throw badRequest('Changing metadata.name is not allowed here');
  }

  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const updated = await replaceResource(manifest, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json(updated);
});

resourcesRouter.delete('/:plural/:name', async (req, res) => {
  setRequestOperation(req, 'resources.delete');
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const result = await deleteResource(req.params.plural, req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  res.json({ ok: true, result });
});

/** Decode secret values (guarded by ALLOW_SECRET_REVEAL). */
resourcesRouter.get('/secrets/:name/reveal', async (req, res) => {
  setRequestOperation(req, 'resources.secret.reveal');
  if (!config.allowSecretReveal) {
    throw badRequest('Secret reveal is disabled on this server (set ALLOW_SECRET_REVEAL=true).');
  }
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const obj: any = await getResource('secrets', req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj.data ?? {})) {
    data[k] = Buffer.from(v as string, 'base64').toString('utf-8');
  }
  res.json({ name: req.params.name, type: obj.type, data });
});

resourcesRouter.put('/configmaps/:name/data', async (req, res) => {
  setRequestOperation(req, 'resources.configmap.update_data');
  const body = z.object({ data: z.record(z.string()) }).safeParse(req.body);
  if (!body.success) throw badRequest('data map is required');

  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const obj: any = await getResource('configmaps', req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  obj.data = body.data.data;

  const updated = await replaceResource(obj, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json(updated);
});

resourcesRouter.put('/secrets/:name/data', async (req, res) => {
  setRequestOperation(req, 'resources.secret.update_data');
  const body = z.object({ data: z.record(z.string()) }).safeParse(req.body);
  if (!body.success) throw badRequest('data map is required');

  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const obj: any = await getResource('secrets', req.params.name, requestedContext, ns(req), kubeOpts(req, selectedKubeconfigPath));
  obj.data = Object.fromEntries(
    Object.entries(body.data.data).map(([key, value]) => [key, Buffer.from(value, 'utf-8').toString('base64')]),
  );
  delete obj.stringData;

  const updated = await replaceResource(obj, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json(updated);
});

function cpuToMillicores(value: string): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1_000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
}

function buildPodMetricsSnapshot(body: any) {
  const containers = Array.isArray(body?.containers) ? body.containers : [];
  return {
    timestamp: body?.timestamp,
    window: body?.window,
    containers: containers.map((container: any) => ({
      name: container.name,
      cpu: container.usage?.cpu ?? '0',
      memory: container.usage?.memory ?? '0',
      cpuMillicores: cpuToMillicores(container.usage?.cpu ?? '0'),
      memoryBytes: memoryToBytes(container.usage?.memory ?? '0'),
    })),
  };
}

function memoryToBytes(value: string): number {
  if (!value) return 0;
  const match = /^([0-9.]+)([KMGTE]i|[kMGTPE]|m)?$/.exec(value);
  if (!match) return Number(value) || 0;
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
