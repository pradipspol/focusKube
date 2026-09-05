import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  AzureLoginManager,
  azAccountShow,
  azGetAksCredentials,
  azListAks,
  azLogout,
  azListSubscriptions,
  azListTenants,
  invalidateAzureCliLoginCache,
  azSetSubscription,
} from '../azure/azure.js';
import { kube } from '../kube/client.js';
import { mergeAksCredentialsIntoKubeconfig, removeContextsFromKubeconfigFile } from '../kube/kubeconfigFile.js';
import { pinTenantId } from '../kube/kubeloginCache.js';
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
import type { CallIdentity } from '../util/callIdentity.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { invalidateContextsCache } from './contexts.js';
import {
  deleteDesktopContextSourcesForNames,
  listDesktopContextSources,
  upsertDesktopContextSource,
} from '../runtime/desktopStore.js';
import {
  allocateCandidateAzureConfigDir,
  deregisterAzureAccount,
  discardCandidateAzureConfigDir,
  getAzureAccountConfigDir,
  listAzureAccounts,
  pruneOrphanAzureConfigDirs,
  registerOrPromoteAzureAccount,
} from '../runtime/azureAccountStore.js';

/**
 * How many `GET /login/status` polls may attempt to reconcile a succeeded login to an email
 * before the attempt is abandoned (and its candidate config dir removed).
 */
const LOGIN_FINALIZE_MAX_ATTEMPTS = 5;

export const azureRouter = Router();
const azureAccountCaches = new Map<string, AsyncRefreshCache<{ account: unknown | null }>>();
const azureAccountsCaches = new Map<string, AsyncRefreshCache<{ accounts: AzureAccountGroup[] }>>();
const azureSubscriptionsCaches = new Map<string, AsyncRefreshCache<{ subscriptions: unknown[] }>>();
const azureAksCaches = new Map<string, AsyncRefreshCache<{ clusters: unknown[] }>>();
// `az aks get-credentials --file <path>` doesn't lock the target kubeconfig file,
// so two concurrent imports of the same cluster (e.g. a double-click) can race and
// leave a duplicated context entry behind. Join concurrent identical requests onto
// one in-flight import instead of letting them both run.
const aksCredentialsInflight = new Map<string, Promise<{ contexts: Awaited<ReturnType<typeof kube.getContexts>>; activeContext: string | null | undefined }>>();

type RawSubscription = {
  id: string;
  name: string;
  isDefault?: boolean;
  homeTenantId?: string;
  tenantId?: string;
  state?: string;
  user?: { name?: string; type?: string };
};

type RawTenant = {
  tenantId?: string;
  displayName?: string;
};

/** A signed-in Azure identity, grouped with the subscriptions it owns. */
type AzureAccountGroup = {
  id: string;
  email: string;
  userType?: string;
  subscriptions: { id: string; name: string; isDefault: boolean; tenantId?: string; tenantDisplayName?: string }[];
};

function tenantNameMap(tenants: RawTenant[]): Map<string, string> {
  return new Map(
    tenants
      .filter((t): t is RawTenant & { tenantId: string; displayName: string } => !!t.tenantId && !!t.displayName)
      .map((t) => [t.tenantId, t.displayName]),
  );
}

function subscriptionsToGroup(subscriptions: RawSubscription[], tenantNames: Map<string, string>, id: string, email: string): AzureAccountGroup {
  return {
    id,
    email,
    userType: subscriptions[0]?.user?.type,
    subscriptions: subscriptions
      .map((sub) => ({
        id: sub.id,
        name: sub.name,
        isDefault: !!sub.isDefault,
        tenantId: sub.tenantId,
        tenantDisplayName: sub.tenantId ? tenantNames.get(sub.tenantId) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Bootstrap-only fallback for installs with no accounts registered yet in the per-account
 * store (i.e. no fresh login has happened since per-account config-dir isolation was added).
 * Groups a single shared config dir's flat `az account list --all` output by owning identity
 * (`sub.user.name`), same as the app did before per-account isolation existed. Once a user
 * signs in through the new flow, `GET /accounts` stops needing this path.
 *
 * The key is email + account type only - NOT tenant. `az account list --all` returns
 * every subscription reachable across every tenant (home tenant plus any guest
 * tenants), and signing in with `az login --tenant <id>` (used to pin a sign-in to a
 * specific tenant, see azLoginManager.start) can make the CLI report `homeTenantId`
 * as that sign-in tenant rather than the account's real home tenant. Keying on tenant
 * would then split one signed-in identity into several bogus "accounts", one per
 * tenant it happens to touch.
 */
function groupAccountsLegacy(subscriptions: RawSubscription[], tenantNames: Map<string, string>): AzureAccountGroup[] {
  const byEmail = new Map<string, RawSubscription[]>();
  for (const sub of subscriptions) {
    const email = sub.user?.name || 'Unknown account';
    const accountId = email.toLowerCase();
    const list = byEmail.get(accountId) ?? [];
    list.push(sub);
    byEmail.set(accountId, list);
  }
  return Array.from(byEmail.entries())
    .map(([accountId, subs]) => subscriptionsToGroup(subs, tenantNames, accountId, subs[0]?.user?.name || 'Unknown account'))
    .sort((a, b) => a.email.localeCompare(b.email));
}

function requestedSource(req: any): SessionScope {
  return normalizeSessionScope((req.query.source as string | undefined) ?? (req.body?.source as string | undefined));
}

function azureAccountCacheFor(req: any): AsyncRefreshCache<{ account: unknown | null }> {
  const source = requestedSource(req);
  const cacheKey = `${source}::${azureConfigDirForSource(req.userSession, source)}`;
  const existing = azureAccountCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ account: unknown | null }>(`azure.account.${cacheKey}`);
  azureAccountCaches.set(cacheKey, created);
  return created;
}

function azureAccountsCacheFor(req: any): AsyncRefreshCache<{ accounts: AzureAccountGroup[] }> {
  const source = requestedSource(req);
  const cacheKey = `${source}::${req.userSession.userId}`;
  const existing = azureAccountsCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ accounts: AzureAccountGroup[] }>(`azure.accounts.${cacheKey}`);
  azureAccountsCaches.set(cacheKey, created);
  return created;
}

function accountIdFromRequest(req: any): string | undefined {
  const raw = (req.query.accountId as string | undefined) ?? (req.body?.accountId as string | undefined);
  const trimmed = raw?.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * An imported AKS context is "owned" by the (account, subscription) pair it came from. Both
 * dimensions matter: the same account can reach a same-named cluster in two subscriptions,
 * and - the case that motivated per-account isolation - two accounts can both reach the SAME
 * subscription, so subscription alone does not identify the owner.
 *
 * Returns false only when a dimension is known on both sides and differs; an unknown
 * dimension is treated as "could be ours", preserving name reuse for legacy untagged docs.
 */
function isSameImportOwner(
  doc: { accountId?: string; subscriptionId?: string },
  accountId: string | undefined,
  subscriptionId: string | undefined,
): boolean {
  if (doc.accountId && accountId && doc.accountId !== accountId) return false;
  if (doc.subscriptionId && subscriptionId && doc.subscriptionId !== subscriptionId) return false;
  return true;
}

/**
 * Stable per-owner suffix. Deterministic rather than "first free wins" so that two accounts
 * racing to import the same cluster name cannot land on the same disambiguated name, and so
 * re-importing always reproduces the name a context already has.
 */
function importDiscriminator(accountId: string | undefined, subscriptionId: string | undefined): string {
  return createHash('sha1').update(`${accountId ?? ''}|${subscriptionId ?? ''}`).digest('hex').slice(0, 8);
}

/** Base identity for an az CLI call, for debug logging - callers can spread and override with call-specific fields (subscription, resource group, cluster). */
function baseIdentity(req: any, source: SessionScope, extra: Partial<CallIdentity> = {}): CallIdentity {
  return {
    userId: req.authUser?.id,
    scope: source,
    accountId: accountIdFromRequest(req),
    ...extra,
  };
}

function azureSubscriptionsCacheFor(req: any): AsyncRefreshCache<{ subscriptions: unknown[] }> {
  const source = requestedSource(req);
  // Must include userId - the backend serves multiple desktop identities out of one process
  // (see desktopUserIdForEmail/runtimeByUserId in session.ts), so a key without it would let
  // two different users' 'local'-scope (or accountId-less 'azure'-scope) requests collide on
  // the same "__default__" bucket and see each other's cached subscriptions.
  const cacheKey = `${source}::${req.userSession.userId}::${accountIdFromRequest(req) ?? '__default__'}`;
  const existing = azureSubscriptionsCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ subscriptions: unknown[] }>(`azure.subscriptions.${cacheKey}`);
  azureSubscriptionsCaches.set(cacheKey, created);
  return created;
}

function azureAksCacheFor(req: any, subscription: string | undefined): AsyncRefreshCache<{ clusters: unknown[] }> {
  const source = requestedSource(req);
  const cacheKey = `${source}::${req.userSession.userId}::${accountIdFromRequest(req) ?? '__default__'}::${subscription ?? '__default__'}`;
  const existing = azureAksCaches.get(cacheKey);
  if (existing) return existing;
  const created = new AsyncRefreshCache<{ clusters: unknown[] }>(`azure.aks.${cacheKey}`);
  azureAksCaches.set(cacheKey, created);
  return created;
}

function invalidateAzureSessionCaches(req: any): void {
  const source = requestedSource(req);
  azureAccountCacheFor(req).invalidate();
  azureAccountsCacheFor(req).invalidate();
  // Scoped to this user's own keys only (source + userId prefix) - every account/subscription
  // variant for this user gets invalidated, but other users' cached data is left alone.
  const prefix = `${source}::${req.userSession.userId}::`;
  for (const [key, cache] of azureSubscriptionsCaches.entries()) {
    if (key.startsWith(prefix)) cache.invalidate();
  }
  for (const [key, cache] of azureAksCaches.entries()) {
    if (key.startsWith(prefix)) cache.invalidate();
  }
}

function envForSource(req: any, source: SessionScope): Record<string, string> {
  return sessionEnvForSource(req, source);
}

/**
 * Env for a specific signed-in account's isolated config dir, for 'azure' scope requests that
 * carry an `accountId` (query or body). Falls back to the legacy shared dir for 'local' scope,
 * or when no accountId is given/registered - covering not-yet-migrated frontend calls and the
 * pre-upgrade bootstrap window.
 */
async function envForAccount(req: any, source: SessionScope): Promise<Record<string, string>> {
  const base = envForSource(req, source);
  if (source !== 'azure') return base;
  const userId = req.authUser?.id;
  const accountId = accountIdFromRequest(req);
  if (!userId || !accountId) return base;
  const dir = await getAzureAccountConfigDir(userId, accountId);
  return dir ? { ...base, AZURE_CONFIG_DIR: dir } : base;
}

azureRouter.get('/account', withRouteErrorLogging('azure', 'GET /account', async (req, res) => {
  setRequestOperation(req, 'azure.account.current');
  const source = requestedSource(req);
  const userId = req.authUser?.id;
  const cache = azureAccountCacheFor(req);
  res.json(
    await cache.get(
      async () => {
        if (source === 'azure' && userId) {
          const registered = await listAzureAccounts(userId);
          const primary = registered[0];
          if (primary) {
            const dir = await getAzureAccountConfigDir(userId, primary.accountId);
            if (dir) {
              const identity = baseIdentity(req, source, { accountId: primary.accountId, accountEmail: primary.email });
              const account = await azAccountShow({ env: { ...envForSource(req, source), AZURE_CONFIG_DIR: dir }, identity });
              return { account };
            }
          }
        }
        return { account: await azAccountShow({ env: envForSource(req, source), identity: baseIdentity(req, source) }) };
      },
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
  const userId = req.authUser?.id;
  const cache = azureAccountsCacheFor(req);

  // `az account list --refresh` is a real round trip to Azure per account, and this endpoint
  // is polled. Each account's isolated config dir is already accurate as of its own `az
  // login`, so --refresh only matters for access granted since then - make it an explicit
  // user action rather than something every background revalidation pays for.
  const wantRefresh = (req.query.refresh as string | undefined) === '1';
  if (wantRefresh) cache.invalidate();

  res.json(
    await cache.get(
      async () => {
        const registered = source === 'azure' && userId ? await listAzureAccounts(userId) : [];

        if (registered.length === 0) {
          // 'local' scope, or no accounts registered yet (pre-upgrade bootstrap): fall back to
          // the legacy shared-dir behavior.
          const env = envForSource(req, source);
          const identity = baseIdentity(req, source);
          const [subscriptions, tenants] = await Promise.all([
            azListSubscriptions({ env, refresh: wantRefresh, identity }) as Promise<RawSubscription[]>,
            azListTenants({ env, identity }) as Promise<RawTenant[]>,
          ]);
          return { accounts: groupAccountsLegacy(subscriptions, tenantNameMap(tenants)) };
        }

        // Each registered account gets its own isolated `az account list --all` call against
        // its own config dir, so a subscription both accounts can see is never silently
        // reassigned from one to the other - unlike sharing one dir, where whichever account
        // most recently logged in/refreshed would "win" it in the local profile cache.
        const groups = await Promise.all(
          registered.map(async (account) => {
            const dir = (await getAzureAccountConfigDir(userId!, account.accountId)) ?? req.userSession.cloudAzureConfigDir;
            const env = { ...envForSource(req, source), AZURE_CONFIG_DIR: dir };
            const identity = baseIdentity(req, source, { accountId: account.accountId, accountEmail: account.email });
            const [subscriptions, tenants] = await Promise.all([
              azListSubscriptions({ env, refresh: wantRefresh, identity }) as Promise<RawSubscription[]>,
              azListTenants({ env, identity }) as Promise<RawTenant[]>,
            ]);
            return subscriptionsToGroup(subscriptions, tenantNameMap(tenants), account.accountId, account.email);
          }),
        );
        return { accounts: groups.sort((a, b) => a.email.localeCompare(b.email)) };
      },
      {
        // These are real CLI process spawns in parallel across accounts; the 100ms default
        // almost always lost the race and fell back to "0 accounts" on a cold or
        // just-invalidated cache, which is what made the Azure panel show one legacy account
        // with 0 subscriptions right after adding a second one.
        waitMs: wantRefresh ? 30_000 : 10_000,
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
  const body = z.object({ tenantId: z.string().min(1).optional() }).safeParse(req.body ?? {});
  const tenantId = body.success ? body.data.tenantId : undefined;

  if (source !== 'azure') {
    const azureConfigDir = azureConfigDirForSource(req.userSession, source);
    invalidateAzureCliLoginCache(azureConfigDir);
    invalidateAzureSessionCaches(req);
    const info = await azureLoginManagerForSource(req.userSession, source).start(tenantId);
    res.json(info);
    return;
  }

  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');

  // Abandon any attempt still in flight before starting another - otherwise the old `az
  // login` keeps polling and can land credentials in a directory nothing references any more.
  const superseded = req.userSession.azureLoginCloudPending;

  // Every "cloud" login attempt - whether "Add Azure account" or reconnecting an existing one -
  // targets a fresh candidate config dir, since the device-code flow doesn't reveal which email
  // will complete login until the user finishes in the browser. GET /login/status reconciles it
  // against the account registry by email once it succeeds.
  const { configDirName, dir } = await allocateCandidateAzureConfigDir(userId);
  invalidateAzureCliLoginCache(dir);
  invalidateAzureSessionCaches(req);
  const manager = new AzureLoginManager(() => ({
    KUBECONFIG: req.userSession.cloudKubeconfigPath,
    AZURE_CONFIG_DIR: dir,
  }));

  // Cancel the superseded attempt and adopt the new manager back-to-back, with no `await` in
  // between. `superseded.manager` is the same object `state.azureLoginCloud` currently aliases
  // (see below), so cancelling it flips that shared fallback's status to 'failed' immediately -
  // if an `await` separated this from reassigning `azureLoginCloud` to the new manager, a
  // concurrent GET /login/status landing in that window would read the cancelled manager's
  // 'failed' status and stop polling for the new attempt, which is actually starting normally.
  if (superseded) {
    superseded.manager.cancel('Superseded by a new Azure login attempt.');
  }
  // GET /login/status falls back to `azureLoginManagerForSource(state, 'azure')` (i.e.
  // `state.azureLoginCloud`) once `azureLoginCloudPending` is cleared. That fallback used to
  // stay pointed at the original idle placeholder created at session startup forever, so a
  // 'succeeded' status was only ever observable on the exact poll that raced finalization -
  // any later poll (a missed response, a duplicate poll) saw a manager that had never run and
  // reported 'idle', which is the likely root of "sign-in complete, loading account..." hangs.
  // Keeping this attempt's manager as the durable fallback makes 'succeeded' (or 'failed')
  // observable on every poll from here on, not just one.
  req.userSession.azureLoginCloud = manager;
  req.userSession.azureLoginCloudPending = { manager, configDirName, configDir: dir, finalizeAttempts: 0 };
  const info = await manager.start(tenantId);
  if (superseded) {
    await discardCandidateAzureConfigDir(userId, superseded.configDirName);
  }
  // Sweep directories left behind by earlier crashed/abandoned attempts. Age-gated inside,
  // so this can never touch an attempt that is still running.
  void pruneOrphanAzureConfigDirs(userId).catch(() => undefined);
  res.json(info);
}));

azureRouter.get('/login/status', withRouteErrorLogging('azure', 'GET /login/status', async (req, res) => {
  setRequestOperation(req, 'azure.login.status');
  const source = requestedSource(req);
  if (source !== 'azure') {
    res.json(azureLoginManagerForSource(req.userSession, source).getStatus());
    return;
  }

  const pending = req.userSession.azureLoginCloudPending;
  if (!pending) {
    res.json(azureLoginManagerForSource(req.userSession, source).getStatus());
    return;
  }

  const status = pending.manager.getStatus();
  const userId = req.authUser?.id;

  if (status.state === 'succeeded' && userId) {
    // Only clear the pending attempt once the account is actually in the registry. Clearing
    // it unconditionally discards a login that really did succeed in the browser: the
    // account never appears, its credentialed directory is orphaned, and the UI sits on
    // "sign-in complete, loading account..." forever. `az account show` returns null on any
    // non-zero exit, which is reachable (e.g. an identity with no default subscription), so
    // retry across polls instead - bounded, so a permanent failure still resolves.
    pending.finalizeAttempts += 1;
    try {
      const account = (await azAccountShow({
        env: { AZURE_CONFIG_DIR: pending.configDir },
        identity: { userId, scope: source, context: undefined },
      })) as { user?: { name?: string } } | null;
      const email = account?.user?.name;
      if (!email) throw new Error('az account show did not report a signed-in user');

      await registerOrPromoteAzureAccount(userId, email, pending.configDirName);
      req.userSession.azureLoginCloudPending = null;
      invalidateAzureSessionCaches(req);
      void pruneOrphanAzureConfigDirs(userId).catch(() => undefined);
    } catch (err) {
      const giveUp = pending.finalizeAttempts >= LOGIN_FINALIZE_MAX_ATTEMPTS;
      logWarn('azure.login.finalize_failed', {
        attempt: pending.finalizeAttempts,
        maxAttempts: LOGIN_FINALIZE_MAX_ATTEMPTS,
        giveUp,
        error: err instanceof Error ? err.message : String(err),
      });
      if (giveUp) {
        req.userSession.azureLoginCloudPending = null;
        // `azureLoginCloud` still aliases `pending.manager` (set in POST /login), whose
        // internal status is genuinely 'succeeded' - the underlying `az login` really did
        // complete; only OUR reconciliation by email failed. Leaving that alias in place would
        // resurrect the stale 'succeeded' status on every later no-pending poll once this
        // response's synthesized 'failed' has been delivered once, reproducing the exact
        // "stuck forever" hang this fallback was introduced to prevent. Replace it with a
        // fresh, idle manager - the same neutral state a session starts in before any login
        // attempt.
        req.userSession.azureLoginCloud = new AzureLoginManager(() => ({
          KUBECONFIG: req.userSession.cloudKubeconfigPath,
          AZURE_CONFIG_DIR: req.userSession.cloudAzureConfigDir,
        }));
        await discardCandidateAzureConfigDir(userId, pending.configDirName);
        invalidateAzureSessionCaches(req);
        res.json({
          ...status,
          state: 'failed' as const,
          message: 'Azure sign-in completed but the account could not be identified. Please try again.',
        });
        return;
      }
      // Report still-pending so the client keeps polling into the retry above.
      res.json({ ...status, state: 'pending' as const, message: 'Finishing Azure sign-in...' });
      return;
    }
  } else if (status.state === 'failed' && userId) {
    // Nothing will ever be registered from this attempt; don't leave its directory behind.
    req.userSession.azureLoginCloudPending = null;
    await discardCandidateAzureConfigDir(userId, pending.configDirName);
  }

  res.json(status);
}));

/**
 * Abandon an in-flight device-code login the user no longer wants to complete - e.g. they
 * opened "Add Azure account" by mistake, or want to stop the device-code prompt without
 * finishing it. Unlike POST /login superseding a prior attempt, this never starts a new one:
 * it just stops the `az login` child and cleans up, leaving any already-registered accounts
 * completely untouched (so, unlike the login mutation's old onMutate, this must NOT invalidate
 * the accounts caches - nothing about them changed).
 */
azureRouter.post('/login/cancel', withRouteErrorLogging('azure', 'POST /login/cancel', async (req, res) => {
  setRequestOperation(req, 'azure.login.cancel');
  const source = requestedSource(req);

  if (source !== 'azure') {
    azureLoginManagerForSource(req.userSession, source).cancel('Cancelled by user.');
    res.json({ ok: true });
    return;
  }

  const userId = req.authUser?.id;
  const pending = req.userSession.azureLoginCloudPending;
  if (pending && userId) {
    req.userSession.azureLoginCloudPending = null;
    pending.manager.cancel('Cancelled by user.');
    // Same reasoning as the give-up branch above: `azureLoginCloud` still aliases this
    // attempt's manager, whose status a later no-pending poll would otherwise keep observing
    // (including 'succeeded', if the underlying `az login` finishes in the background right
    // after the user clicks Cancel). Replace it with a fresh idle manager so this abandoned
    // attempt can never resurface.
    req.userSession.azureLoginCloud = new AzureLoginManager(() => ({
      KUBECONFIG: req.userSession.cloudKubeconfigPath,
      AZURE_CONFIG_DIR: req.userSession.cloudAzureConfigDir,
    }));
    await discardCandidateAzureConfigDir(userId, pending.configDirName);
  }
  res.json({ ok: true });
}));

azureRouter.get('/subscriptions', withRouteErrorLogging('azure', 'GET /subscriptions', async (req, res) => {
  setRequestOperation(req, 'azure.subscriptions.list');
  const source = requestedSource(req);
  const cache = azureSubscriptionsCacheFor(req);
  res.json(
    await cache.get(
      async () => ({
        subscriptions: (await azListSubscriptions({
          env: await envForAccount(req, source),
          identity: baseIdentity(req, source),
        })) as unknown[],
      }),
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
  // An optional username (email) signs out a single account; omitting it logs out everything
  // registered for this scope.
  const body = z
    .object({ username: z.string().min(1).optional(), source: z.enum(['local', 'cloud']).optional() })
    .safeParse(req.body ?? {});
  if (!body.success) throw badRequest('Invalid request body');

  if (source !== 'azure') {
    const azureConfigDir = azureConfigDirForSource(req.userSession, source);
    await azLogout({ env: envForSource(req, source), username: body.data.username, identity: baseIdentity(req, source) });
    invalidateAzureCliLoginCache(azureConfigDir);
    invalidateAzureSessionCaches(req);
    res.json({ ok: true });
    return;
  }

  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');
  const targetEmail = body.data.username?.trim().toLowerCase();
  const registered = await listAzureAccounts(userId);
  const targets = targetEmail ? registered.filter((account) => account.accountId === targetEmail) : registered;

  for (const account of targets) {
    const dir = await getAzureAccountConfigDir(userId, account.accountId);
    const identity = baseIdentity(req, source, { accountId: account.accountId, accountEmail: account.email });
    if (dir) {
      await azLogout({ env: { AZURE_CONFIG_DIR: dir }, identity }).catch(() => undefined);
      invalidateAzureCliLoginCache(dir);
    }
    await deregisterAzureAccount(userId, account.email);
  }

  // Sign out of the legacy shared dir when the request targets an account that was never
  // registered under per-account isolation (pre-upgrade installs keep every identity's
  // credentials there), and always for a "sign out everything" request. Passing the username
  // through keeps a single-account sign-out from taking the others down with it.
  if (targets.length === 0 || !targetEmail) {
    const legacyDir = req.userSession.cloudAzureConfigDir;
    await azLogout({
      env: { AZURE_CONFIG_DIR: legacyDir },
      username: targetEmail,
      identity: baseIdentity(req, source),
    }).catch(() => undefined);
    invalidateAzureCliLoginCache(legacyDir);
  }

  // A signed-out account's imported contexts can no longer authenticate, so remove them
  // rather than leaving dead entries in the tree. Untagged legacy contexts are only removed
  // by a sign-out-everything request - there is no way to attribute them to one account.
  const aksSources = (await listDesktopContextSources(userId)).filter((doc) => doc.source === 'aks');
  const contextNames = new Set<string>(
    (targetEmail ? aksSources.filter((doc) => doc.accountId === targetEmail) : aksSources).map((doc) => doc.contextName),
  );
  if (contextNames.size > 0) {
    const activeRemoved = !!req.userSession.activeContext && contextNames.has(req.userSession.activeContext);
    // Best effort: a corrupt kubeconfig must not block signing out.
    await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, contextNames).catch((err) => {
      logWarn('azure.logout.context_removal_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    if (activeRemoved) {
      req.userSession.activeContext = null;
      req.userSession.activeContextSource = null;
    }
    await deleteDesktopContextSourcesForNames(userId, 'azure', contextNames);
    kube.invalidateLoadConfigCache(req.userSession.cloudKubeconfigPath);
    invalidateContextsCache(req);
  }

  invalidateAzureSessionCaches(req);
  res.json({ ok: true, removed: Array.from(contextNames) });
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

  const targetEmail = body.data.email.toLowerCase();
  const sources = (await listDesktopContextSources(userId)).filter((doc) => doc.source === 'aks');
  // A doc's `accountId` tag is ground truth for ownership - it was recorded at import time
  // against the account whose isolated config dir the import actually ran under, so no CLI
  // round trip is needed to attribute it. Only docs that predate the tag (imported before
  // per-account isolation) fall back to a live subscription-ownership lookup below.
  const taggedMatches = sources.filter((doc) => doc.accountId === targetEmail);
  const legacyUntagged = sources.filter((doc) => !doc.accountId);

  let legacyMatches: typeof sources = [];
  if (legacyUntagged.length > 0) {
    const dir = (await getAzureAccountConfigDir(userId, targetEmail)) ?? req.userSession.cloudAzureConfigDir;
    const subscriptions = (await azListSubscriptions({
      env: { ...envForSource(req, source), AZURE_CONFIG_DIR: dir },
      identity: baseIdentity(req, source, { accountId: targetEmail, accountEmail: targetEmail }),
    })) as RawSubscription[];
    const owned = subscriptions.filter((sub) => (sub.user?.name || 'Unknown account').toLowerCase() === targetEmail);
    const ownedIds = new Set(owned.map((sub) => sub.id));
    const ownedNames = new Set(owned.map((sub) => sub.name));
    // Subscription names aren't unique across tenants/accounts (e.g. "Production" can exist
    // in two different signed-in accounts), so a name match is only trustworthy here as a
    // fallback for docs that predate subscriptionId tracking - never alongside an id that
    // disagrees. When a doc has an id, that id is the sole source of truth.
    legacyMatches = legacyUntagged.filter((doc) =>
      doc.subscriptionId ? ownedIds.has(doc.subscriptionId) : !!doc.subscriptionName && ownedNames.has(doc.subscriptionName),
    );
  }

  const toRemove = [...taggedMatches, ...legacyMatches];
  const contextNames = new Set<string>(toRemove.map((doc) => doc.contextName));
  const activeRemoved = !!req.userSession.activeContext && contextNames.has(req.userSession.activeContext);
  await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, contextNames);
  if (activeRemoved) req.userSession.activeContext = null;
  await deleteDesktopContextSourcesForNames(userId, 'azure', contextNames);
  invalidateContextsCache(req);
  invalidateAzureSessionCaches(req);
  res.json({ ok: true, removed: Array.from(contextNames) });
}));

azureRouter.post('/subscription', async (req, res) => {
  setRequestOperation(req, 'azure.subscription.set');
  const source = requestedSource(req);
  const body = z.object({ id: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('id is required');
  await azSetSubscription(body.data.id, {
    env: await envForAccount(req, source),
    identity: baseIdentity(req, source, { subscriptionId: body.data.id }),
  });
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
      async () => ({
        clusters: (await azListAks(subscription, {
          env: await envForAccount(req, source),
          identity: baseIdentity(req, source, { subscriptionId: subscription }),
        })) as unknown[],
      }),
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
      accountId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw badRequest('resourceGroup and name are required');

  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');

  const kubeconfigPath = kubeconfigPathForSource(req.userSession, source);
  const accountId = accountIdFromRequest(req);
  // Subscription (and account) are part of the identity of this import: two different
  // accounts/subscriptions can have a same-named cluster in a same-named resource group, and
  // must not be folded onto the same in-flight promise (which would hand the second caller the
  // first caller's result).
  const inflightKey = [
    userId,
    kubeconfigPath,
    accountId ?? '__default__',
    body.data.subscription ?? '__default__',
    body.data.resourceGroup,
    body.data.name,
    !!body.data.admin,
  ].join('::');
  const existingImport = aksCredentialsInflight.get(inflightKey);
  const importPromise =
    existingImport ??
    (async () => {
      const env = await envForAccount(req, source);
      const identity = baseIdentity(req, source, {
        subscriptionId: body.data.subscription,
        resourceGroup: body.data.resourceGroup,
        clusterName: body.data.name,
      });
      const [subscriptions, tenants] = await Promise.all([
        azListSubscriptions({ env, identity }) as Promise<RawSubscription[]>,
        azListTenants({ env, identity }) as Promise<RawTenant[]>,
      ]);
      const selectedSubscription = body.data.subscription
        ? subscriptions.find((sub) => sub.id === body.data.subscription)
        : subscriptions.find((sub) => sub.isDefault) ?? subscriptions[0];
      const tenantName = selectedSubscription?.tenantId ? tenantNameMap(tenants).get(selectedSubscription.tenantId) : undefined;
      identity.subscriptionId = selectedSubscription?.id ?? identity.subscriptionId;
      identity.subscriptionName = selectedSubscription?.name;
      identity.tenantId = selectedSubscription?.tenantId;
      identity.tenantName = tenantName;

      // `az aks get-credentials` names its cluster/user/context entries purely from the cluster
      // name and resource group, with no subscription/tenant in the name - importing straight
      // into the shared kubeconfig with --overwrite-existing would let one account's cluster
      // silently clobber another account's same-named cluster. Import into an isolated scratch
      // file first, then merge it into the shared file under a name we control.
      const scratchKubeconfigPath = path.join(path.dirname(kubeconfigPath), `.aks-import-${randomUUID()}.yaml`);
      let contextName: string;
      try {
        await azGetAksCredentials({
          ...body.data,
          kubeconfigPath: scratchKubeconfigPath,
          env,
          identity,
        });

        ({ contextName } = await mergeAksCredentialsIntoKubeconfig(
          scratchKubeconfigPath,
          kubeconfigPath,
          async (defaultName) => {
            // Read inside the merge lock, so a concurrent import cannot make this same
            // decision from state that predates the other one's claim.
            const existingSources = (await listDesktopContextSources(userId)).filter((doc) => doc.source === 'aks');
            const claimedByAnotherOwner = existingSources.some(
              (doc) =>
                doc.contextName === defaultName &&
                !isSameImportOwner(doc, accountId, selectedSubscription?.id),
            );
            if (!claimedByAnotherOwner) return defaultName;
            return `${defaultName}--${importDiscriminator(accountId, selectedSubscription?.id)}`;
          },
          // Still inside the lock: record the claim before the lock is released.
          async (resolvedName) => {
            await upsertDesktopContextSource(userId, {
              contextName: resolvedName,
              scope: 'azure',
              source: 'aks',
              subscriptionId: selectedSubscription?.id,
              subscriptionName: selectedSubscription?.name,
              resourceGroup: body.data.resourceGroup,
              clusterName: body.data.name,
              // Links this context back to the account whose isolated config dir owns it, so
              // the live-use auth path (session.ts's azureConfigDirForContext) resolves the
              // right dir instead of falling back to the legacy shared one.
              accountId,
              tenantId: selectedSubscription?.tenantId,
              tenantName,
            });
          },
        ));
      } finally {
        await fsp.unlink(scratchKubeconfigPath).catch(() => undefined);
      }

      invalidateAzureSessionCaches(req);
      kube.invalidateLoadConfigCache(req.userSession.cloudKubeconfigPath);
      // Pin this context to the tenant its subscription actually belongs
      // to (ground truth from `az account list`), so kubelogin always
      // requests that tenant for it instead of whatever tenant happens
      // to be the shared Azure CLI session's ambient default.
      if (selectedSubscription?.tenantId) {
        await pinTenantId(env.AZURE_CONFIG_DIR ?? azureConfigDirForSource(req.userSession, source), contextName, selectedSubscription.tenantId);
      }

      const contexts = await kube.getContexts(req.userSession.cloudKubeconfigPath, req.userSession.activeContext);
      return { contexts, activeContext: contextName };
    })();

  if (!existingImport) {
    aksCredentialsInflight.set(inflightKey, importPromise);
    importPromise.finally(() => aksCredentialsInflight.delete(inflightKey));
  }

  const { contexts, activeContext } = await importPromise;

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
