import { Router } from 'express';
import { z } from 'zod';
import {
  azAccountShow,
  azGetAksCredentials,
  azListAks,
  azLogout,
  azListSubscriptions,
  invalidateAzureCliLoginCache,
  azSetSubscription,
} from '../azure/azure.js';
import { kube } from '../kube/client.js';
import { removeContextsFromKubeconfigFile } from '../kube/kubeconfigFile.js';
import { badRequest } from '../util/httpError.js';
import {
  azureConfigDirForSource,
  azureLoginManagerForSource,
  kubeconfigPathForSource,
  normalizeSessionScope,
  setSessionContextSourceHint,
  sessionEnvForSource,
  type SessionScope,
} from '../auth/session.js';
import { setRequestOperation } from '../util/requestOp.js';
import { AsyncRefreshCache } from '../util/asyncCache.js';
import { logWarn } from '../util/logger.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { invalidateContextsCache } from './contexts.js';
import {
  deleteDesktopContextSourcesForNames,
  listDesktopContextSources,
  upsertDesktopContextSource,
} from '../runtime/desktopStore.js';

export const azureRouter = Router();
const azureAccountCaches = new Map<string, AsyncRefreshCache<{ account: unknown | null }>>();
const azureAccountsCaches = new Map<string, AsyncRefreshCache<{ accounts: AzureAccountGroup[] }>>();
const azureSubscriptionsCaches = new Map<string, AsyncRefreshCache<{ subscriptions: unknown[] }>>();
const azureAksCaches = new Map<string, AsyncRefreshCache<{ clusters: unknown[] }>>();

type SubscriptionSummary = {
  id: string;
  name: string;
  isDefault: boolean;
};

type RawSubscription = {
  id: string;
  name: string;
  isDefault?: boolean;
  tenantId?: string;
  state?: string;
  user?: { name?: string; type?: string };
};

/** A signed-in Azure identity, grouped with the subscriptions it owns. */
type AzureAccountGroup = {
  email: string;
  userType?: string;
  subscriptions: { id: string; name: string; isDefault: boolean; tenantId?: string }[];
};

/**
 * The Azure CLI config dir can hold several signed-in accounts at once. Group the
 * flat `az account list --all` output by the owning identity (user.name) so the UI
 * can present one node per account.
 */
function groupAccounts(subscriptions: RawSubscription[]): AzureAccountGroup[] {
  const byEmail = new Map<string, AzureAccountGroup>();
  for (const sub of subscriptions) {
    const email = sub.user?.name || 'Unknown account';
    let group = byEmail.get(email);
    if (!group) {
      group = { email, userType: sub.user?.type, subscriptions: [] };
      byEmail.set(email, group);
    }
    group.subscriptions.push({
      id: sub.id,
      name: sub.name,
      isDefault: !!sub.isDefault,
      tenantId: sub.tenantId,
    });
  }
  for (const group of byEmail.values()) {
    group.subscriptions.sort((a, b) => a.name.localeCompare(b.name));
  }
  return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
}

function azureAccountCacheFor(req: any): AsyncRefreshCache<{ account: unknown | null }> {
  const source = normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
  const cacheKey = `${source}::${azureConfigDirForSource(req.userSession, source)}`;
  const existing = azureAccountCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ account: unknown | null }>(`azure.account.${cacheKey}`);
  azureAccountCaches.set(cacheKey, created);
  return created;
}

function azureAccountsCacheFor(req: any): AsyncRefreshCache<{ accounts: AzureAccountGroup[] }> {
  const source = normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
  const cacheKey = `${source}::${azureConfigDirForSource(req.userSession, source)}`;
  const existing = azureAccountsCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ accounts: AzureAccountGroup[] }>(`azure.accounts.${cacheKey}`);
  azureAccountsCaches.set(cacheKey, created);
  return created;
}

function azureSubscriptionsCacheFor(req: any): AsyncRefreshCache<{ subscriptions: unknown[] }> {
  const source = normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
  const cacheKey = `${source}::${azureConfigDirForSource(req.userSession, source)}`;
  const existing = azureSubscriptionsCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ subscriptions: unknown[] }>(`azure.subscriptions.${cacheKey}`);
  azureSubscriptionsCaches.set(cacheKey, created);
  return created;
}

function azureAksCacheFor(req: any, subscription: string | undefined): AsyncRefreshCache<{ clusters: unknown[] }> {
  const source = normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
  const cacheKey = `${source}::${azureConfigDirForSource(req.userSession, source)}::${subscription ?? '__default__'}`;
  const existing = azureAksCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ clusters: unknown[] }>(`azure.aks.${cacheKey}`);
  azureAksCaches.set(cacheKey, created);
  return created;
}

function invalidateAzureSessionCaches(req: any): void {
  const source = normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
  const dir = azureConfigDirForSource(req.userSession, source);
  azureAccountCacheFor(req).invalidate();
  azureAccountsCacheFor(req).invalidate();
  azureSubscriptionsCacheFor(req).invalidate();
  const prefix = `${source}::${dir}::`;
  for (const [key, cache] of azureAksCaches.entries()) {
    if (key.startsWith(prefix)) cache.invalidate();
  }
}

function requestedSource(req: any): SessionScope {
  return normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
}

function envForSource(req: any, source: SessionScope): Record<string, string> {
  return sessionEnvForSource(req, source);
}

azureRouter.get('/account', withRouteErrorLogging('azure', 'GET /account', async (req, res) => {
  setRequestOperation(req, 'azure.account.current');
  const source = requestedSource(req);
  const cache = azureAccountCacheFor(req);
  res.json(
    await cache.get(
      () => azAccountShow({ env: envForSource(req, source) }).then((account) => ({ account })),
      {
        // az account show spawns a real CLI process; the default 100ms wait would
        // almost always fall back to "not signed in" before it finishes.
        waitMs: 8_000,
        fallback: () => ({ account: null }),
        onError: (err) => {
          logWarn('azure.account_cache.refresh_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    ),
  );
}));

azureRouter.get('/accounts', withRouteErrorLogging('azure', 'GET /accounts', async (req, res) => {
  setRequestOperation(req, 'azure.accounts.list');
  const source = requestedSource(req);
  const cache = azureAccountsCacheFor(req);
  res.json(
    await cache.get(
      async () => {
        const subscriptions = (await azListSubscriptions({ env: envForSource(req, source) })) as RawSubscription[];
        return { accounts: groupAccounts(subscriptions) };
      },
      {
        fallback: () => ({ accounts: [] }),
        onError: (err) => {
          logWarn('azure.accounts_cache.refresh_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    ),
  );
}));

azureRouter.post('/login', withRouteErrorLogging('azure', 'POST /login', async (req, res) => {
  setRequestOperation(req, 'azure.login.start');
  const source = requestedSource(req);
  const azureConfigDir = azureConfigDirForSource(req.userSession, source);
  invalidateAzureCliLoginCache(azureConfigDir);
  invalidateAzureSessionCaches(req);
  const info = await azureLoginManagerForSource(req.userSession, source).start();
  res.json(info);
}));

azureRouter.get('/login/status', withRouteErrorLogging('azure', 'GET /login/status', (req, res) => {
  setRequestOperation(req, 'azure.login.status');
  const source = requestedSource(req);
  res.json(azureLoginManagerForSource(req.userSession, source).getStatus());
}));

azureRouter.get('/subscriptions', withRouteErrorLogging('azure', 'GET /subscriptions', async (req, res) => {
  setRequestOperation(req, 'azure.subscriptions.list');
  const source = requestedSource(req);
  const cache = azureSubscriptionsCacheFor(req);
  res.json(
    await cache.get(
      async () => ({ subscriptions: (await azListSubscriptions({ env: envForSource(req, source) })) as unknown[] }),
      {
        fallback: () => ({ subscriptions: [] }),
        onError: (err) => {
          logWarn('azure.subscriptions_cache.refresh_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    ),
  );
}));

azureRouter.post('/logout', withRouteErrorLogging('azure', 'POST /logout', async (req, res) => {
  setRequestOperation(req, 'azure.logout');
  const source = requestedSource(req);
  const azureConfigDir = azureConfigDirForSource(req.userSession, source);
  // An optional username signs out a single account; omitting it logs out everything.
  const body = z
    .object({ username: z.string().min(1).optional(), source: z.enum(['local', 'cloud']).optional() })
    .safeParse(req.body ?? {});
  if (!body.success) throw badRequest('Invalid request body');
  await azLogout({ env: envForSource(req, source), username: body.data.username });
  invalidateAzureCliLoginCache(azureConfigDir);
  invalidateAzureSessionCaches(req);
  res.json({ ok: true });
}));

/**
 * Disconnect an account's imported AKS clusters: drop the kube-contexts that were
 * imported from subscriptions owned by this account, but leave the account signed in.
 */
azureRouter.post('/accounts/disconnect', withRouteErrorLogging('azure', 'POST /accounts/disconnect', async (req, res) => {
  setRequestOperation(req, 'azure.accounts.disconnect');
  const source = requestedSource(req);
  if (source !== 'azure') {
    throw badRequest('Disconnecting imported AKS clusters is only supported for azure scope.');
  }
  const body = z.object({ email: z.string().min(1) }).safeParse(req.body ?? {});
  if (!body.success) throw badRequest('email is required');
  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');

  const subscriptions = (await azListSubscriptions({ env: envForSource(req, source) })) as RawSubscription[];
  const owned = subscriptions.filter((sub) => (sub.user?.name || 'Unknown account') === body.data.email);
  const ownedIds = new Set(owned.map((sub) => sub.id));
  const ownedNames = new Set(owned.map((sub) => sub.name));

  const sources = (await listDesktopContextSources(userId)).filter((doc) => doc.source === 'aks');
  const toRemove = sources.filter(
    (doc) =>
      (doc.subscriptionId && ownedIds.has(doc.subscriptionId)) ||
      (doc.subscriptionName && ownedNames.has(doc.subscriptionName)),
  );
  const contextNames = new Set<string>(toRemove.map((doc) => doc.contextName));
  const activeRemoved = !!req.userSession.activeContext && contextNames.has(req.userSession.activeContext);
  await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, contextNames);
  if (activeRemoved) req.userSession.activeContext = null;
  await deleteDesktopContextSourcesForNames(userId, contextNames);
  invalidateContextsCache(req);
  invalidateAzureSessionCaches(req);
  res.json({ ok: true, removed: Array.from(contextNames) });
}));

azureRouter.post('/subscription', async (req, res) => {
  setRequestOperation(req, 'azure.subscription.set');
  const source = requestedSource(req);
  const body = z.object({ id: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('id is required');
  await azSetSubscription(body.data.id, { env: envForSource(req, source) });
  invalidateAzureSessionCaches(req);
  res.json({ ok: true });
});

azureRouter.get('/aks', async (req, res) => {
  setRequestOperation(req, 'azure.aks.list');
  const source = requestedSource(req);
  const subscription = (req.query.subscription as string) || undefined;
  const cache = azureAksCacheFor(req, subscription);
  res.json(
    await cache.get(
      async () => ({ clusters: (await azListAks(subscription, { env: envForSource(req, source) })) as unknown[] }),
      {
        waitMs: 60_000,
        fallback: () => ({ clusters: [] }),
        onError: (err) => {
          logWarn('azure.aks_cache.refresh_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    ),
  );
});

azureRouter.post('/aks/credentials', async (req, res) => {
  setRequestOperation(req, 'azure.aks.credentials');
  const source = requestedSource(req);
  if (source !== 'azure') {
    throw badRequest('Importing AKS credentials is only supported for azure scope.');
  }
  const body = z
    .object({
      resourceGroup: z.string().min(1),
      name: z.string().min(1),
      subscription: z.string().optional(),
      admin: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw badRequest('resourceGroup and name are required');

  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');

  const before = new Set(
    (await kube.getContexts(req.userSession.cloudKubeconfigPath, req.userSession.activeContext)).map((ctx) => ctx.name),
  );

  const subscriptions = (await azListSubscriptions({ env: envForSource(req, source) })) as SubscriptionSummary[];
  const selectedSubscription = body.data.subscription
    ? subscriptions.find((sub) => sub.id === body.data.subscription)
    : subscriptions.find((sub) => sub.isDefault) ?? subscriptions[0];

  await azGetAksCredentials({
    ...body.data,
    kubeconfigPath: kubeconfigPathForSource(req.userSession, source),
    env: envForSource(req, source),
  });

  invalidateAzureSessionCaches(req);
  kube.invalidateLoadConfigCache(req.userSession.cloudKubeconfigPath);

  const contexts = await kube.getContexts(req.userSession.cloudKubeconfigPath, req.userSession.activeContext);
  const imported = contexts.filter((ctx) => !before.has(ctx.name));
  const contextCandidates = contexts.filter((ctx) => {
    const match = /^cluster(?:User|Admin)_(.+?)_(.+)$/.exec(ctx.user ?? '');
    if (!match) return false;
    return match[1] === body.data.resourceGroup && match[2] === body.data.name;
  });
  const contextsToTag = contextCandidates.length > 0 ? contextCandidates : imported;
  const activeContext =
    contextsToTag.find((ctx) => ctx.name === body.data.name)?.name ?? contextsToTag[0]?.name ?? req.userSession.activeContext;

  if (contextsToTag.length > 0) {
    for (const ctx of contextsToTag) {
      await upsertDesktopContextSource(userId, {
        contextName: ctx.name,
        source: 'aks',
        subscriptionId: selectedSubscription?.id,
        subscriptionName: selectedSubscription?.name,
        resourceGroup: body.data.resourceGroup,
        clusterName: body.data.name,
      });
    }
  }

  if (activeContext) {
    req.userSession.activeContext = activeContext;
    req.userSession.activeContextSource = 'azure';
    setSessionContextSourceHint(req.userSession, activeContext, 'azure');
  } else if (!req.userSession.activeContext && contexts.length > 0) {
    req.userSession.activeContext = contexts[0].name;
    req.userSession.activeContextSource = 'azure';
    setSessionContextSourceHint(req.userSession, contexts[0].name, 'azure');
  }
  invalidateContextsCache(req);
  res.json({ ok: true, active: req.userSession.activeContext ?? undefined, contexts });
});
