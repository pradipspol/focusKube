import * as k8s from '@kubernetes/client-node';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError, notFound } from '../util/httpError.js';
import { logInfo, logWarn, logError } from '../util/logger.js';

interface KubeClientOptions {
  kubeconfigPath?: string;
  fallbackContext?: string | null;
}

/**
 * Manages kubeconfig loading and produces typed API clients for a chosen
 * context. The "active" context is held in memory; individual requests may also
 * target a specific context. We never mutate the user's kubeconfig file here —
 * CLI calls (helm/kubectl) receive the context explicitly instead.
 */
class KubeManager {
  private loadConfigCache = new Map<string, { kc: k8s.KubeConfig; timestamp: number }>();
  private readonly CACHE_TTL_MS = 5000; // 5 second TTL

  constructor() {}

  /** Invalidate kubeconfig cache (call after updating kubeconfig file). */
  invalidateLoadConfigCache(kubeconfigPath?: string): void {
    const cacheKey = kubeconfigPath ?? config.kubeconfigPath ?? 'in-cluster';
    this.loadConfigCache.delete(cacheKey);
  }

  /** (Re)load kubeconfig from file/default/in-cluster. */
  private async loadConfig(kubeconfigPath?: string): Promise<k8s.KubeConfig> {
    const cacheKey = kubeconfigPath ?? config.kubeconfigPath ?? 'in-cluster';
    const cached = this.loadConfigCache.get(cacheKey);
    const now = Date.now();

    // Return cached config if still fresh
    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.kc;
    }

    const kc = new k8s.KubeConfig();
    try {
      if (process.env.KUBERNETES_SERVICE_HOST) {
        // Running inside a cluster.
        logInfo('kubeconfig.resolve', {
          source: 'in-cluster',
          kubeconfigPath: null,
          candidates: [],
          operation: 'kube.loadConfig',
        });
        kc.loadFromCluster();
      } else {
        const resolution = await resolveKubeconfigFile(kubeconfigPath ?? config.kubeconfigPath);
        logInfo('kubeconfig.resolve', {
          source: resolution.source,
          kubeconfigPath: resolution.selectedPath ?? null,
          candidates: resolution.candidates,
          operation: 'kube.loadConfig',
        });
        if (resolution.selectedPath) {
          // A brand-new user session may have an intentionally empty kubeconfig
          // until AKS credentials are imported.
          const stat = await fsp.stat(resolution.selectedPath);
          if (stat.size === 0) {
            logWarn('kubeconfig.load.empty', {
              kubeconfigPath: resolution.selectedPath,
              operation: 'kube.loadConfig',
            });
            this.loadConfigCache.set(cacheKey, { kc, timestamp: now });
            return kc;
          }
          const content = await fsp.readFile(resolution.selectedPath, 'utf8');
          kc.loadFromString(content);
          logInfo('kubeconfig.load.file', {
            kubeconfigPath: resolution.selectedPath,
            source: resolution.source,
            sizeBytes: stat.size,
            operation: 'kube.loadConfig',
          });
        }
      }
    } catch (err) {
      // Start empty; the user can still log into Azure and pull credentials.
      logError('kubeconfig.load.failed', {
        kubeconfigPath: kubeconfigPath ?? config.kubeconfigPath ?? null,
        error: err instanceof Error ? err.message : String(err),
        operation: 'kube.loadConfig',
      });
    }

    this.loadConfigCache.set(cacheKey, { kc, timestamp: now });
    return kc;
  }

  async getContexts(kubeconfigPath?: string, activeContext?: string | null) {
    const kc = await this.loadConfig(kubeconfigPath);
    const selected =
      activeContext !== undefined ? activeContext || undefined : await this.defaultContext(kc);

    return kc.getContexts().map((ctx) => ({
      name: ctx.name,
      cluster: ctx.cluster,
      user: ctx.user,
      namespace: ctx.namespace,
      active: !!selected && ctx.name === selected,
    }));
  }

  async isContextConnected(contextName: string, kubeconfigPath?: string): Promise<boolean> {
    const startedHr = process.hrtime.bigint();
    try {
      // Probe the Kubernetes version endpoint so connectivity does not depend
      // on namespace-list RBAC permissions.
      await withTimeout(
        (await this.configForContext(contextName, { kubeconfigPath })).makeApiClient(k8s.VersionApi).getCode(),
        config.k8sContextProbeTimeoutMs,
        `Context probe timed out after ${config.k8sContextProbeTimeoutMs}ms`,
      );
      return true;
    } catch (err) {
      const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
      logError('k8s.context.probe_failed', {
        contextName,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        timeoutMs: config.k8sContextProbeTimeoutMs,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Returns a KubeConfig whose current context is the requested (or active) one. */
  private configForContext(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.KubeConfig> {
    return this._configForContext(contextName, options);
  }

  private async _configForContext(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.KubeConfig> {

    try {
      const kc = await this.loadConfig(options.kubeconfigPath);
      const fallbackContext = options.fallbackContext === null ? undefined : options.fallbackContext;

      const preferred = contextName ?? fallbackContext;
      let target = preferred && this.isUsableContext(kc, preferred) ? preferred : undefined;
      if (!target) {
        target = await this.defaultContext(kc);
      }
      if (!target) {
        throw new HttpError(400, 'No Kubernetes context selected. Load a kubeconfig or sign in to Azure first.');
      }
      const exists = kc.getContexts().some((c) => c.name === target);
      if (!exists) throw notFound(`Context not found: ${target}`);
      if (!this.isUsableContext(kc, target)) {
        throw new HttpError(
          400,
          `Context "${target}" has no active cluster mapping. Refresh kubeconfig or import AKS credentials again.`,
        );
      }

      // Clone so concurrent requests targeting different contexts don't clash.
      logInfo('kubeconfig.clone.start', { target, operation: 'kube.configForContext' });
      const exportStart = Date.now();
      const exported = kc.exportConfig();
      logInfo('kubeconfig.export.complete', { target, elapsedMs: Date.now() - exportStart });

      const loadStart = Date.now();
      const cloned = new k8s.KubeConfig();
      cloned.loadFromString(exported);
      logInfo('kubeconfig.clone.complete', { target, elapsedMs: Date.now() - loadStart, operation: 'kube.configForContext' });

      cloned.setCurrentContext(target);
      return cloned;
    } catch (err) {
      logError('kubeconfig.clone.failed', {
        target: contextName ?? options.fallbackContext ?? null,
        error: err instanceof Error ? err.message : String(err),
        operation: 'kube.configForContext',
        kubeOptions: JSON.stringify(options),
        fullError: JSON.stringify(err)
      });
      throw err;
    }
  }

  private isUsableContext(kc: k8s.KubeConfig, name: string): boolean {
    const ctx = kc.getContexts().find((c) => c.name === name);
    if (!ctx?.cluster) return false;
    return kc.getClusters().some((cl) => cl.name === ctx.cluster);
  }

  private async defaultContext(kc: k8s.KubeConfig): Promise<string | undefined> {
    const current = kc.getCurrentContext();
    if (current && this.isUsableContext(kc, current)) {
      return current;
    }
    return kc.getContexts().find((c) => this.isUsableContext(kc, c.name))?.name;
  }

  /** The context name CLIs (helm/kubectl) should use. */
  resolveContextName(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<string> {
    return this._resolveContextName(contextName, options);
  }

  private async _resolveContextName(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<string> {
    const target = contextName ?? options.fallbackContext ?? await this.defaultContext(await this.loadConfig(options.kubeconfigPath));
    if (!target) {
      throw new HttpError(400, 'No Kubernetes context selected.');
    }
    return target;
  }

  core(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.CoreV1Api> {
    return this._configForContext(contextName, options).then((kc) => kc.makeApiClient(k8s.CoreV1Api));
  }

  apps(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.AppsV1Api> {
    return this._configForContext(contextName, options).then((kc) => kc.makeApiClient(k8s.AppsV1Api));
  }

  batch(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.BatchV1Api> {
    return this._configForContext(contextName, options).then((kc) => kc.makeApiClient(k8s.BatchV1Api));
  }

  networking(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.NetworkingV1Api> {
    return this._configForContext(contextName, options).then((kc) => kc.makeApiClient(k8s.NetworkingV1Api));
  }

  rawConfig(
    contextName?: string,
    options: KubeClientOptions = {},
  ): Promise<k8s.KubeConfig> {
    return this._configForContext(contextName, options);
  }
}

interface KubeconfigResolution {
  source: 'explicit' | 'kubeconfig' | 'home' | 'none';
  selectedPath?: string;
  candidates: Array<{ source: string; path: string; exists: boolean }>;
}

async function resolveKubeconfigFile(explicitPath?: string): Promise<KubeconfigResolution> {
  const candidates: Array<{ source: string; path: string; exists: boolean }> = [];

  if (explicitPath) candidates.push({ source: 'explicit', path: explicitPath, exists: await fileExists(explicitPath) });

  // KUBECONFIG may contain multiple paths separated by ; on Windows and : on Unix.
  if (process.env.KUBECONFIG) {
    const parts = process.env.KUBECONFIG
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      candidates.push({ source: 'KUBECONFIG', path: part, exists: await fileExists(part) });
    }
  }

  // const homePath = path.join(os.homedir(), '.kube', 'config');
  // candidates.push({ source: 'home', path: homePath, exists: await fileExists(homePath) });

  const selected = candidates.find((candidate) => candidate.exists);
  return {
    source: selected?.source === 'explicit' ? 'explicit' : selected?.source === 'KUBECONFIG' ? 'kubeconfig' : selected?.source === 'home' ? 'home' : 'none',
    selectedPath: selected?.path,
    candidates,
  };
}

async function fileExists(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(candidatePath);
    return stat.isFile();
  } catch (err) {
    logWarn('kubeconfig.file_exists_failed', {
      candidatePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const kube = new KubeManager();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
