import * as k8s from '@kubernetes/client-node';
import type { SessionScope } from '../auth/session.js';
import type { DesktopContextSourceDoc, DesktopLocalKubeconfigDoc } from '../runtime/desktopStore.js';
import { AsyncRefreshCache } from '../util/asyncCache.js';
import { badRequest } from '../util/httpError.js';

export type ContextEntry = {
  ctx: {
    name: string;
    cluster: string;
    user: string;
    namespace?: string;
    active: boolean;
  };
  scope: SessionScope;
};

export type ContextsPayload = {
  active?: string;
  contexts: Array<{
    name: string;
    cluster: string;
    user: string;
    namespace?: string;
    active: boolean;
    connected?: boolean;
    source?: {
      provider: 'aks' | 'eks' | 'local' | 'minikube';
      subscriptionId?: string;
      subscriptionName?: string;
      resourceGroup?: string;
      clusterName?: string;
      accountId?: string;
      region?: string;
    };
  }>;
  localKubeconfigs: Array<{
    id: string;
    name: string;
    contexts: string[];
    createdAt: string;
    updatedAt: string;
  }>;
};

function sourceKey(scope: SessionScope, contextName: string): string {
  return `${scope}::${contextName}`;
}

export class ContextsService {
  private caches = new Map<string, AsyncRefreshCache<ContextsPayload>>();

  requireUserKey(userId?: string | null): string {
    if (!userId) throw badRequest('User not found');
    return userId;
  }

  parseKubeconfigContexts(content: string): string[] {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromString(content);
    } catch (err) {
      throw badRequest('Invalid kubeconfig file', (err as Error).message);
    }
    return kc.getContexts().map((ctx) => ctx.name);
  }

  mapLocalKubeconfigs(docs: DesktopLocalKubeconfigDoc[]): ContextsPayload['localKubeconfigs'] {
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      contexts: doc.contexts,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    }));
  }

  sourceForEntry(scope: SessionScope, contextName: string, sourceDoc?: DesktopContextSourceDoc): ContextsPayload['contexts'][number]['source'] {
    if (sourceDoc) {
      if (sourceDoc.source === 'eks') {
        return {
          provider: 'eks',
          accountId: sourceDoc.accountId,
          region: sourceDoc.region,
          clusterName: sourceDoc.clusterName,
        };
      }
      return {
        provider: 'aks',
        subscriptionId: sourceDoc.subscriptionId,
        subscriptionName: sourceDoc.subscriptionName,
        resourceGroup: sourceDoc.resourceGroup,
        clusterName: sourceDoc.clusterName,
        accountId: sourceDoc.accountId,
      };
    }

    if (scope === 'local') {
      return { provider: 'local' };
    }
    if (scope === 'minikube') {
      return { provider: 'minikube', clusterName: contextName };
    }
    if (scope === 'aws') {
      return {
        provider: 'eks',
        clusterName: contextName,
      };
    }
    if (scope === 'azure') {
      return {
        provider: 'aks',
        clusterName: contextName,
      };
    }
    return undefined;
  }

  mapContextSources(
    entries: ContextEntry[],
    sourceDocs: DesktopContextSourceDoc[],
  ): Map<string, DesktopContextSourceDoc> {
    const entryKeys = new Set(entries.map((entry) => sourceKey(entry.scope, entry.ctx.name)));
    return new Map(
      sourceDocs
        .filter((doc) => entryKeys.has(sourceKey(doc.scope, doc.contextName)))
        .map((doc) => [sourceKey(doc.scope, doc.contextName), doc]),
    );
  }

  buildPayload(args: {
    activeContext: string | null;
    entries: ContextEntry[];
    sourceDocs: DesktopContextSourceDoc[];
    localKubeconfigs: ContextsPayload['localKubeconfigs'];
    skipConnectivity?: boolean;
  }): ContextsPayload {
    const sourceByContext = this.mapContextSources(args.entries, args.sourceDocs);

    return {
      active: args.activeContext ?? undefined,
      contexts: args.entries.map(({ ctx, scope }) => {
        const sourceDoc = sourceByContext.get(sourceKey(scope, ctx.name));
        return {
          ...ctx,
          connected: false,
          source: this.sourceForEntry(scope, ctx.name, sourceDoc),
        };
      }),
      localKubeconfigs: args.localKubeconfigs,
    };
  }

  cacheForUser(userId: string): AsyncRefreshCache<ContextsPayload> {
    const existing = this.caches.get(userId);
    if (existing) return existing;
    const created = new AsyncRefreshCache<ContextsPayload>(`contexts.${userId}`);
    this.caches.set(userId, created);
    return created;
  }

  invalidateCache(userId: string): void {
    this.cacheForUser(userId).invalidate();
  }

  async getCachedPayload(
    userId: string,
    loader: () => Promise<ContextsPayload>,
    fallback: () => Promise<ContextsPayload>,
    onError: (err: unknown) => void,
  ): Promise<ContextsPayload> {
    const cache = this.cacheForUser(userId);
    return cache.get(loader, { fallback, onError });
  }
}

export const contextsService = new ContextsService();
