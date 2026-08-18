import { promises as fsp } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { SessionScope } from '../auth/session.js';
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
import { callK8s } from '../util/k8sError.js';
import { badRequest, HttpError } from '../util/httpError.js';

const POD_METRICS_BATCH_CONCURRENCY = 10;

export type KubeOptions = {
  kubeconfigPath: string;
  fallbackContext: string | null;
};

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
  }

  throw err;
}

function cpuToMillicores(value: string): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1_000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
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

export class ResourcesService {
  listKinds() {
    return Object.values(RESOURCE_KINDS);
  }

  parseApplyManifest(rawYaml: string, defaultNamespace?: string): any {
    let manifest: any;
    try {
      manifest = yaml.load(rawYaml);
    } catch (err) {
      throw badRequest('Invalid YAML', (err as Error).message);
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw badRequest('YAML must be a single Kubernetes object');
    }
    if (!manifest.apiVersion || !manifest.kind || !manifest.metadata?.name) {
      throw badRequest('YAML must include apiVersion, kind and metadata.name');
    }
    if (!manifest.metadata.namespace && defaultNamespace) {
      manifest.metadata.namespace = defaultNamespace;
    }

    return manifest;
  }

  parseEditableManifest(rawYaml: string, plural: string, expectedName: string): any {
    let manifest: any;
    try {
      manifest = yaml.load(rawYaml);
    } catch (err) {
      throw badRequest('Invalid YAML', (err as Error).message);
    }

    if (!manifest || typeof manifest !== 'object' || !manifest.kind || !manifest.metadata?.name) {
      throw badRequest('YAML must be a single Kubernetes object with kind and metadata.name');
    }

    const rk = resolveKind(plural);
    if (manifest.kind !== rk.kind) {
      throw badRequest(`YAML kind "${manifest.kind}" does not match "${rk.kind}"`);
    }
    if (manifest.metadata.name !== expectedName) {
      throw badRequest('Changing metadata.name is not allowed here');
    }

    return manifest;
  }

  async applyResource(manifest: any, context: string | undefined, options: KubeOptions) {
    return applyManifest(manifest, context, options);
  }

  async getPodMetrics(
    podName: string,
    namespace: string,
    context: string | undefined,
    options: KubeOptions,
  ) {
    const api = (await kube.rawConfig(context, options)).makeApiClient(k8s.CustomObjectsApi);
    const metricsRes = await callK8s(() =>
      api.getNamespacedCustomObject('metrics.k8s.io', 'v1beta1', namespace, 'pods', podName),
    );
    return buildPodMetricsSnapshot((metricsRes as any).body ?? metricsRes);
  }

  async getPodMetricsBatch(
    podsInput: Array<string | { name: string; namespace?: string }>,
    defaultNamespace: string | undefined,
    context: string | undefined,
    options: KubeOptions,
  ): Promise<{ items: Array<{ name: string; namespace?: string; snapshot?: any; error?: string }> }> {
    const api = (await kube.rawConfig(context, options)).makeApiClient(k8s.CustomObjectsApi);

    const pods = podsInput.map((pod) => {
      if (typeof pod === 'string') {
        return { name: pod, namespace: defaultNamespace };
      }
      return { name: pod.name, namespace: pod.namespace ?? defaultNamespace };
    });

    if (pods.some((pod) => !pod.namespace)) {
      throw badRequest('namespace query parameter is required when any pod item omits namespace');
    }

    const uniquePods = Array.from(new Map(pods.map((pod) => [`${pod.namespace}/${pod.name}`, pod] as const)).values());
    const items: Array<{ name: string; namespace?: string; snapshot?: any; error?: string }> = [];

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

    return { items };
  }

  async listResources(
    plural: string,
    context: string | undefined,
    namespace: string | undefined,
    options: KubeOptions,
    args: {
      rawLimit?: string;
      rawContinue?: string;
      rawAttributes?: string;
      selectedScope: SessionScope;
      selectedKubeconfigPath: string;
    },
  ): Promise<{ items: any[] } | any> {
    const attributes = args.rawAttributes
      ? args.rawAttributes
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a)
      : undefined;

    if (args.rawLimit || args.rawContinue) {
      const limit = args.rawLimit ? Math.max(1, Math.min(250, Number(args.rawLimit))) : undefined;
      try {
        return await listResourcePage(plural, context, namespace, { ...options, attributes, limit, continue: args.rawContinue });
      } catch (err) {
        await maybeWrapAbortAsAzureAuthRequired(err, args.selectedScope, args.selectedKubeconfigPath);
        wrapInteractiveAzureAuthError(err, args.selectedScope);
      }
    }

    try {
      const items = await listResource(plural, context, namespace, { ...options, attributes });
      return { items };
    } catch (err) {
      await maybeWrapAbortAsAzureAuthRequired(err, args.selectedScope, args.selectedKubeconfigPath);
      wrapInteractiveAzureAuthError(err, args.selectedScope);
    }
  }

  async getResource(plural: string, name: string, context: string | undefined, namespace: string | undefined, options: KubeOptions) {
    return getResource(plural, name, context, namespace, options);
  }

  async getResourceYaml(plural: string, name: string, context: string | undefined, namespace: string | undefined, options: KubeOptions) {
    const obj = await getResource(plural, name, context, namespace, options);
    return { yaml: yaml.dump(sanitizeForEdit(obj as any)) };
  }

  async replaceFromYaml(
    rawYaml: string,
    plural: string,
    name: string,
    context: string | undefined,
    options: KubeOptions,
  ) {
    const manifest = this.parseEditableManifest(rawYaml, plural, name);
    return replaceResource(manifest, context, options);
  }

  async deleteResource(plural: string, name: string, context: string | undefined, namespace: string | undefined, options: KubeOptions) {
    const result = await deleteResource(plural, name, context, namespace, options);
    return { ok: true, result };
  }

  async revealSecret(name: string, context: string | undefined, namespace: string | undefined, options: KubeOptions) {
    const obj: any = await getResource('secrets', name, context, namespace, options);
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.data ?? {})) {
      data[k] = Buffer.from(v as string, 'base64').toString('utf-8');
    }
    return { name, type: obj.type, data };
  }

  async updateConfigMapData(
    name: string,
    data: Record<string, string>,
    context: string | undefined,
    namespace: string | undefined,
    options: KubeOptions,
  ) {
    const obj: any = await getResource('configmaps', name, context, namespace, options);
    obj.data = data;
    return replaceResource(obj, context, options);
  }

  async updateSecretData(
    name: string,
    data: Record<string, string>,
    context: string | undefined,
    namespace: string | undefined,
    options: KubeOptions,
  ) {
    const obj: any = await getResource('secrets', name, context, namespace, options);
    obj.data = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value, 'utf-8').toString('base64')]),
    );
    delete obj.stringData;
    return replaceResource(obj, context, options);
  }

  parseBatchPods(body: unknown): Array<string | { name: string; namespace?: string }> {
    const parsed = z
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
      .safeParse(body);

    if (!parsed.success) throw badRequest('pods is required and must be a non-empty array');
    return parsed.data.pods;
  }
}

export const resourcesService = new ResourcesService();