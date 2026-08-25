import * as k8s from '@kubernetes/client-node';
import { kube } from '../kube/client.js';
import { resourceWatchPath } from '../kube/resources.js';
import type { ChangeEventStore } from './store.js';
import { WATCHED_KINDS, EVENT_KIND } from './watchedKinds.js';
import { logInfo, logError, logWarn } from '../util/logger.js';
import { broadcastObservabilityEvent } from '../ws/observability.js';

interface InformerCacheEntry {
  informer: k8s.Informer<any> & k8s.ObjectCache<any>;
  lastKnownState: Map<string, any>;
}

type ScopeMode = 'cluster' | 'namespace';

function isForbiddenError(err: unknown): boolean {
  if (!err) return false;
  const candidate = err as any;
  const status = candidate.statusCode ?? candidate.status ?? candidate.response?.statusCode ?? candidate.response?.status;
  if (Number(status) === 403) return true;
  const body = candidate.body ?? candidate.response?.body;
  const msg = [
    err instanceof Error ? err.message : String(err),
    typeof body === 'string' ? body : JSON.stringify(body ?? ''),
  ].join(' ');
  return /forbidden/i.test(msg) || /status(?: code)?\s*[:=]?\s*403/i.test(msg);
}

export class Recording {
  private informers: Map<string, InformerCacheEntry> = new Map();
  private flushQueue: any[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly recordingId: string;
  private readonly context: string;
  private readonly userId: string;
  private readonly kubeconfigPath?: string;
  private readonly fallbackContext?: string;
  private readonly retentionMs: number;
  private serverUrl?: string;
  private informerScopeMode: ScopeMode = 'cluster';
  private namespaceForScope?: string;

  constructor(
    recordingId: string,
    context: string,
    userId: string,
    private store: ChangeEventStore,
    kubeconfigPath?: string,
    fallbackContext?: string,
    retentionMs = 72 * 60 * 60 * 1000,
    serverUrl?: string,
  ) {
    this.recordingId = recordingId;
    this.context = context;
    this.userId = userId;
    this.kubeconfigPath = kubeconfigPath;
    this.fallbackContext = fallbackContext;
    this.retentionMs = retentionMs;
    this.serverUrl = serverUrl;
  }

  async start(): Promise<void> {
    try {
      const kubeConfig = await kube.rawConfig(this.context, {
        kubeconfigPath: this.kubeconfigPath,
        fallbackContext: this.fallbackContext,
      });

      this.namespaceForScope = await this.resolveNamespace(kubeConfig);
      this.informerScopeMode = await this.resolveScopeMode(kubeConfig);

      logInfo('observability.recording.scope_mode', {
        recordingId: this.recordingId,
        context: this.context,
        scopeMode: this.informerScopeMode,
        namespace: this.namespaceForScope,
      });

      for (const kind of WATCHED_KINDS) {
        await this.startInformer(kubeConfig, kind.id, kind.resourceKind.plural);
      }

      await this.startEventInformer(kubeConfig);

      logInfo('observability.recording.started', {
        recordingId: this.recordingId,
        context: this.context,
        informerCount: this.informers.size,
        scopeMode: this.informerScopeMode,
        namespace: this.namespaceForScope,
      });
    } catch (err) {
      logError('observability.recording.start_failed', {
        recordingId: this.recordingId,
        context: this.context,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  }

  private async startInformer(kubeConfig: k8s.KubeConfig, kindId: string, plural: string): Promise<void> {
    const watchPath =
      this.informerScopeMode === 'namespace' && this.namespaceForScope
        ? resourceWatchPath(plural, this.namespaceForScope)
        : resourceWatchPath(plural);
    const resourceKind = WATCHED_KINDS.find((k) => k.id === kindId)?.resourceKind;

    const listFn = async (): Promise<any> => {
      try {
        if (!resourceKind) {
          return { response: { statusCode: 200 } as any, body: { items: [], metadata: {} } as any };
        }

        let result: any;
        if (resourceKind.apiVersion === 'v1') {
          const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
          const methodName =
            this.informerScopeMode === 'namespace'
              ? `listNamespaced${resourceKind.kind}`
              : `list${resourceKind.kind}ForAllNamespaces`;
          const method = (coreApi as any)[methodName];
          if (typeof method === 'function') {
            result =
              this.informerScopeMode === 'namespace' && this.namespaceForScope
                ? await method.call(coreApi, this.namespaceForScope)
                : await method.call(coreApi);
          }
        } else if (resourceKind.apiVersion === 'apps/v1') {
          const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
          const methodName =
            this.informerScopeMode === 'namespace'
              ? `listNamespaced${resourceKind.kind}`
              : `list${resourceKind.kind}ForAllNamespaces`;
          const method = (appsApi as any)[methodName];
          if (typeof method === 'function') {
            result =
              this.informerScopeMode === 'namespace' && this.namespaceForScope
                ? await method.call(appsApi, this.namespaceForScope)
                : await method.call(appsApi);
          }
        }

        if (!result) {
          return { response: { statusCode: 200 } as any, body: { items: [], metadata: {} } as any };
        }

        const body = (result && typeof result === 'object' && 'body' in result) ? result.body : result;
        return { response: { statusCode: 200 } as any, body: body || { items: [] } };
      } catch (err) {
        logWarn('observability.informer.list_error', {
          recordingId: this.recordingId,
          context: this.context,
          kind: kindId,
          plural,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    const informer = k8s.makeInformer(kubeConfig, watchPath, listFn);

    const cache = new Map<string, any>();

    informer.on('add', (obj: any) => {
      const uid = obj.metadata?.uid;
      if (!uid) return;

      const kind = WATCHED_KINDS.find((k) => k.id === kindId);
      if (!kind) return;

      const changes = kind.extractChanges(undefined, obj);
      if (changes.length > 0) {
        logInfo('observability.informer.event_add', {
          recordingId: this.recordingId,
          kind: kindId,
          changeCount: changes.length,
        });
        this.queueChanges(changes);
      }
      cache.set(uid, obj);
    });

    informer.on('update', (obj: any) => {
      const uid = obj.metadata?.uid;
      if (!uid) return;

      const kind = WATCHED_KINDS.find((k) => k.id === kindId);
      if (!kind) return;

      const prev = cache.get(uid);
      const changes = kind.extractChanges(prev, obj);
      if (changes.length > 0) {
        logInfo('observability.informer.event_update', {
          recordingId: this.recordingId,
          kind: kindId,
          changeCount: changes.length,
        });
        this.queueChanges(changes);
      }
      cache.set(uid, obj);
    });

    informer.on('delete', (obj: any) => {
      const uid = obj.metadata?.uid;
      if (!uid) return;

      const namespace = obj.metadata?.namespace;
      const name = obj.metadata?.name;
      const kind = WATCHED_KINDS.find((k) => k.id === kindId)?.resourceKind.kind;

      if (kind && name && namespace) {
        logInfo('observability.informer.event_delete', {
          recordingId: this.recordingId,
          kind: kindId,
          name,
          namespace,
        });
        this.queueChanges([
          {
            kind: kind as any,
            namespace,
            name,
            uid,
            ts: new Date(),
            category: 'workloadChange',
            changeType: 'deleted',
            severity: 'info',
            summary: `${kind} ${name} deleted from ${namespace}`,
          },
        ]);
      }
      cache.delete(uid);
    });

    informer.on('error', (err: any) => {
      logError('observability.informer.error', {
        recordingId: this.recordingId,
        context: this.context,
        kind: kindId,
        scopeMode: this.informerScopeMode,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await informer.start();
    this.informers.set(kindId, { informer, lastKnownState: cache });

    logInfo('observability.informer.started', {
      recordingId: this.recordingId,
      context: this.context,
      kind: kindId,
      scopeMode: this.informerScopeMode,
    });
  }
  private async startEventInformer(kubeConfig: k8s.KubeConfig): Promise<void> {
    const watchPath =
      this.informerScopeMode === 'namespace' && this.namespaceForScope
        ? resourceWatchPath('events', this.namespaceForScope)
        : resourceWatchPath('events');

    const listFn = async (): Promise<any> => {
      try {
        const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
        const result =
          this.informerScopeMode === 'namespace' && this.namespaceForScope
            ? await coreApi.listNamespacedEvent(this.namespaceForScope)
            : await coreApi.listEventForAllNamespaces();
        const body = (result && typeof result === 'object' && 'body' in result) ? result.body : result;
        return { response: { statusCode: 200 } as any, body: body || { items: [] } };
      } catch (err) {
        logWarn('observability.event_informer.list_error', {
          recordingId: this.recordingId,
          context: this.context,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    const informer = k8s.makeInformer(kubeConfig, watchPath, listFn);

    informer.on('add', (obj: any) => {
      const changes = EVENT_KIND.extractChanges(undefined, obj);
      this.queueEventChanges(changes);
    });

    informer.on('update', (obj: any) => {
      const changes = EVENT_KIND.extractChanges(undefined, obj);
      this.queueEventChanges(changes);
    });

    informer.on('error', (err: any) => {
      logError('observability.event_informer.error', {
        recordingId: this.recordingId,
        context: this.context,
        scopeMode: this.informerScopeMode,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await informer.start();
    this.informers.set('events', { informer, lastKnownState: new Map() });

    logInfo('observability.event_informer.started', {
      recordingId: this.recordingId,
      context: this.context,
      scopeMode: this.informerScopeMode,
    });
  }

  private async resolveNamespace(kubeConfig: k8s.KubeConfig): Promise<string | undefined> {
    try {
      const current = kubeConfig.getCurrentContext();
      const ctx = kubeConfig.getContexts().find((c) => c.name === current);
      if (ctx?.namespace) return ctx.namespace;
    } catch {
      // Ignore and continue with default fallback.
    }
    return 'default';
  }

  private async resolveScopeMode(kubeConfig: k8s.KubeConfig): Promise<ScopeMode> {
    const namespace = this.namespaceForScope;
    if (!namespace) return 'cluster';

    try {
      const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
      await coreApi.listPodForAllNamespaces(undefined, undefined, undefined, undefined, 1);
      return 'cluster';
    } catch (err) {
      if (!isForbiddenError(err)) {
        throw err;
      }
      logWarn('observability.recording.cluster_scope_forbidden', {
        recordingId: this.recordingId,
        context: this.context,
        namespace,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'namespace';
    }
  }

  private queueChanges(changes: any[]): void {
    this.flushQueue.push(...changes.map((c) => ({ ...c, isEvent: false })));
    this.scheduleFlush();
  }

  private queueEventChanges(changes: any[]): void {
    this.flushQueue.push(...changes.map((c) => ({ ...c, isEvent: true })));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 1000);
  }

  private async flush(): Promise<void> {
    if (this.flushQueue.length === 0) {
      this.flushTimer = null;
      return;
    }

    const batch = this.flushQueue.splice(0, this.flushQueue.length);
    this.flushTimer = null;

    logInfo('observability.recording.flush_start', {
      recordingId: this.recordingId,
      context: this.context,
      batchSize: batch.length,
    });

    try {
      for (const change of batch) {
        if (change.isEvent) {
          await this.store.upsertEvent(this.recordingId, change, this.retentionMs, this.context);
        } else {
          await this.store.insertChanges(this.recordingId, [change], this.retentionMs, this.context);
        }
        broadcastObservabilityEvent(this.context, change);
      }

      logInfo('observability.recording.flush_complete', {
        recordingId: this.recordingId,
        context: this.context,
        batchSize: batch.length,
      });
    } catch (err) {
      logError('observability.recording.flush_failed', {
        recordingId: this.recordingId,
        context: this.context,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    await this.flush();

    for (const { informer } of this.informers.values()) {
      try {
        await informer.stop();
      } catch (err) {
        logWarn('observability.informer.stop_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.informers.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);

    logInfo('observability.recording.stopped', {
      recordingId: this.recordingId,
      context: this.context,
    });
  }
}
