import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { buildTestApp, makeTestAuthUser, makeTestSession } from '../testUtils/testApp.js';

const realAzure = await import('../azure/azure.js');
let accountShowResult: unknown = { user: { name: 'me@example.com' } };
let subscriptionsResult: unknown[] = [];
let tenantsResult: unknown[] = [];
// Per-config-dir subscription lists, keyed by the AZURE_CONFIG_DIR passed to azListSubscriptions -
// lets multi-account tests simulate two isolated dirs returning different (and overlapping) data.
let subscriptionsByConfigDir: Record<string, unknown[]> = {};
let logoutCalls: Array<{ env?: Record<string, string>; username?: string }> = [];
// How many times azListSubscriptions has been called - lets a test prove a code path did
// (or, for the disconnect route's accountId-tag fast path, deliberately did NOT) pay for a
// live `az account list` round trip.
let subscriptionsCallCount = 0;

mock.module('../azure/azure.js', {
  namedExports: {
    ...realAzure,
    azAccountShow: async () => accountShowResult,
    azListSubscriptions: async (options?: { env?: Record<string, string> }) => {
      subscriptionsCallCount += 1;
      const dir = options?.env?.AZURE_CONFIG_DIR;
      if (dir && subscriptionsByConfigDir[dir]) return subscriptionsByConfigDir[dir];
      return subscriptionsResult;
    },
    azListTenants: async () => tenantsResult,
    azLogout: async (options?: { env?: Record<string, string>; username?: string }) => {
      logoutCalls.push({ env: options?.env, username: options?.username });
    },
    azListAks: async () => ({ clusters: [] }),
    azGetAksCredentials: async () => ({ contexts: [], activeContext: null }),
    invalidateAzureCliLoginCache: () => undefined,
    azSetSubscription: async () => undefined,
  },
});

let registeredAccounts: Array<{ accountId: string; email: string; configDirName: string; createdAt: Date; updatedAt: Date }> = [];
const configDirByAccountId: Record<string, string> = {};

// Desktop store + kubeconfig merge fixtures, so the import route can be exercised without
// touching a real kubeconfig file.
let contextSources: any[] = [];
let upsertedSources: any[] = [];
let mergeResolvedNames: string[] = [];
let removedContextNames: string[] = [];
/** The name `az aks get-credentials` would have produced, which the route then disambiguates. */
let mergeDefaultName = 'aks-default-context';

const realDesktopStore = await import('../runtime/desktopStore.js');
mock.module('../runtime/desktopStore.js', {
  namedExports: {
    ...realDesktopStore,
    listDesktopContextSources: async () => contextSources,
    getDesktopContextSource: async (_userId: string, scope: string, contextName: string) =>
      contextSources.find((doc) => doc.scope === scope && doc.contextName === contextName),
    upsertDesktopContextSource: async (_userId: string, source: any) => {
      upsertedSources.push(source);
      contextSources = [
        ...contextSources.filter((doc) => !(doc.scope === source.scope && doc.contextName === source.contextName)),
        source,
      ];
    },
    deleteDesktopContextSourcesForNames: async (_userId: string, _scope: string, names: Iterable<string>) => {
      const set = new Set(names);
      contextSources = contextSources.filter((doc) => !set.has(doc.contextName));
    },
  },
});

const realKubeconfigFile = await import('../kube/kubeconfigFile.js');
mock.module('../kube/kubeconfigFile.js', {
  namedExports: {
    ...realKubeconfigFile,
    // Mirrors the real contract: resolve the name, then run the claim callback, both of which
    // the real implementation does while holding the target file's lock.
    mergeAksCredentialsIntoKubeconfig: async (
      _source: string,
      _target: string,
      resolveContextName: (n: string) => string | Promise<string>,
      onMerged?: (n: string) => void | Promise<void>,
    ) => {
      const contextName = await resolveContextName(mergeDefaultName);
      mergeResolvedNames.push(contextName);
      if (onMerged) await onMerged(contextName);
      return { contextName };
    },
    removeContextsFromKubeconfigFile: async (_path: string, names: Set<string>) => {
      removedContextNames = Array.from(names);
      return names.size > 0;
    },
  },
});

// Spread the real module first so adding an export to azureAccountStore.ts can't turn this
// into a module-load SyntaxError (a missing name fails the whole file, not one assertion).
const realAzureAccountStore = await import('../runtime/azureAccountStore.js');

mock.module('../runtime/azureAccountStore.js', {
  namedExports: {
    ...realAzureAccountStore,
    listAzureAccounts: async () => registeredAccounts,
    getAzureAccountConfigDir: async (_userId: string, accountId: string) => configDirByAccountId[accountId],
    allocateCandidateAzureConfigDir: async () => ({ configDirName: 'candidate', dir: '/tmp/candidate' }),
    registerOrPromoteAzureAccount: async (_userId: string, email: string, configDirName: string) => {
      const accountId = email.toLowerCase();
      const record = { accountId, email, configDirName, createdAt: new Date(), updatedAt: new Date() };
      registeredAccounts = [...registeredAccounts.filter((a) => a.accountId !== accountId), record];
      return record;
    },
    deregisterAzureAccount: async (_userId: string, email: string) => {
      const accountId = email.toLowerCase();
      registeredAccounts = registeredAccounts.filter((a) => a.accountId !== accountId);
    },
    // Never touch the real filesystem from route tests.
    discardCandidateAzureConfigDir: async () => undefined,
    pruneOrphanAzureConfigDirs: async () => [],
  },
});

const { azureRouter } = await import('./azure.js');

function app() {
  return buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/azure/account returns the signed-in account', async () => {
  accountShowResult = { user: { name: 'me@example.com' } };

  const res = await request(app()).get('/api/azure/account');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { account: { user: { name: 'me@example.com' } } });
});

test('GET /api/azure/accounts groups subscriptions by account', async () => {
  subscriptionsResult = [
    { id: 'sub-1', name: 'Sub One', isDefault: true, tenantId: 'tenant-1', user: { name: 'me@example.com' } },
  ];
  tenantsResult = [{ tenantId: 'tenant-1', displayName: 'Contoso' }];

  const res = await request(app()).get('/api/azure/accounts');
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 1);
  assert.equal(res.body.accounts[0].email, 'me@example.com');
  assert.equal(res.body.accounts[0].subscriptions[0].tenantDisplayName, 'Contoso');
});

test('GET /api/azure/accounts groups one identity across tenants into a single account', async () => {
  // `az account list --all` returns every subscription reachable across every tenant
  // for a given login, and per-tenant sign-ins can report differing homeTenantId
  // values for the same identity - neither should fragment the grouped account.
  subscriptionsResult = [
    { id: 'sub-1', name: 'Sub One', isDefault: true, tenantId: 'tenant-1', homeTenantId: 'tenant-1', user: { name: 'me@example.com', type: 'user' } },
    { id: 'sub-2', name: 'Sub Two', tenantId: 'tenant-2', homeTenantId: 'tenant-2', user: { name: 'me@example.com', type: 'user' } },
    { id: 'sub-3', name: 'Sub Three', tenantId: 'tenant-3', user: { name: 'Me@example.com', type: 'user' } },
  ];
  tenantsResult = [];

  // Use the 'local' scope so this hits its own cache bucket, not the one the
  // preceding 'cloud'-scoped test already warmed.
  const res = await request(app()).get('/api/azure/accounts?source=local');
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 1);
  assert.equal(res.body.accounts[0].subscriptions.length, 3);
});

test('GET /api/azure/subscriptions lists subscriptions', async () => {
  subscriptionsResult = [{ id: 'sub-1', name: 'Sub One' }];

  const res = await request(app()).get('/api/azure/subscriptions');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { subscriptions: [{ id: 'sub-1', name: 'Sub One' }] });
});

test('GET /api/azure/accounts attributes each registered account its own subscriptions, including a shared one, without cross-leak', async () => {
  registeredAccounts = [
    { accountId: 'prapol@ptc.com', email: 'prapol@ptc.com', configDirName: 'dir-a', createdAt: new Date(), updatedAt: new Date() },
    { accountId: 'sghosh@ptc.com', email: 'sghosh@ptc.com', configDirName: 'dir-b', createdAt: new Date(), updatedAt: new Date() },
  ];
  configDirByAccountId['prapol@ptc.com'] = '/tmp/dir-a';
  configDirByAccountId['sghosh@ptc.com'] = '/tmp/dir-b';
  subscriptionsByConfigDir = {
    // Both accounts have access to the same "PTC" subscription - each account's own isolated
    // `az account list` call must still report it, independently of the other account's call.
    '/tmp/dir-a': [
      { id: 'sub-shared', name: 'PTC Core', tenantId: 'tenant-ptc' },
      { id: 'sub-a-only', name: 'A Only', tenantId: 'tenant-a' },
    ],
    '/tmp/dir-b': [
      { id: 'sub-shared', name: 'PTC Core', tenantId: 'tenant-ptc' },
      { id: 'sub-b-only', name: 'B Only', tenantId: 'tenant-b' },
    ],
  };
  tenantsResult = [];

  // Distinct session userId so this doesn't hit the accounts cache warmed by an earlier test
  // using the default session (the cache key is scope + session userId).
  const session = makeTestSession({ userId: 'multi-account-test-user' });
  const res = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session })).get(
    '/api/azure/accounts?source=azure',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 2);

  const prapol = res.body.accounts.find((a: any) => a.email === 'prapol@ptc.com');
  const sghosh = res.body.accounts.find((a: any) => a.email === 'sghosh@ptc.com');
  assert.equal(prapol.subscriptions.length, 2);
  assert.equal(sghosh.subscriptions.length, 2);
  assert.ok(prapol.subscriptions.some((s: any) => s.id === 'sub-shared'));
  assert.ok(sghosh.subscriptions.some((s: any) => s.id === 'sub-shared'));

  registeredAccounts = [];
  configDirByAccountId['prapol@ptc.com'] = undefined as any;
  configDirByAccountId['sghosh@ptc.com'] = undefined as any;
});

test('POST /api/azure/logout with a username deregisters only that account', async () => {
  registeredAccounts = [
    { accountId: 'prapol@ptc.com', email: 'prapol@ptc.com', configDirName: 'dir-a', createdAt: new Date(), updatedAt: new Date() },
    { accountId: 'sghosh@ptc.com', email: 'sghosh@ptc.com', configDirName: 'dir-b', createdAt: new Date(), updatedAt: new Date() },
  ];
  configDirByAccountId['prapol@ptc.com'] = '/tmp/dir-a';
  configDirByAccountId['sghosh@ptc.com'] = '/tmp/dir-b';
  logoutCalls = [];

  const res = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser() }))
    .post('/api/azure/logout')
    .send({ username: 'prapol@ptc.com' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    registeredAccounts.map((a) => a.accountId),
    ['sghosh@ptc.com'],
  );
  assert.equal(logoutCalls.length, 1);
  assert.equal(logoutCalls[0].env?.AZURE_CONFIG_DIR, '/tmp/dir-a');

  registeredAccounts = [];
  configDirByAccountId['prapol@ptc.com'] = undefined as any;
  configDirByAccountId['sghosh@ptc.com'] = undefined as any;
});

test('POST /api/azure/logout falls back to the legacy shared dir for an account that was never registered', async () => {
  // Pre-isolation installs have no registry entries, but their credentials do exist in the
  // shared config dir. A per-account sign-out must still reach them instead of silently
  // reporting success and leaving the account signed in.
  registeredAccounts = [];
  logoutCalls = [];

  const session = makeTestSession({ userId: 'legacy-logout-user', cloudAzureConfigDir: '/tmp/legacy-shared' });
  const res = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session }))
    .post('/api/azure/logout')
    .send({ username: 'legacy@ptc.com' });

  assert.equal(res.status, 200);
  assert.equal(logoutCalls.length, 1);
  assert.equal(logoutCalls[0].env?.AZURE_CONFIG_DIR, '/tmp/legacy-shared');
  // Scoped to the requested account only - it must not sign the other identities out too.
  assert.equal(logoutCalls[0].username, 'legacy@ptc.com');
});

test('POST /api/azure/aks/credentials disambiguates when another ACCOUNT already claimed the name in the same subscription', async () => {
  // The case per-account isolation exists for: two accounts with access to one shared
  // subscription. Keying disambiguation on subscription alone would let the second import
  // reuse the name and steal the first account's context.
  contextSources = [
    {
      contextName: 'shared-cluster',
      scope: 'azure',
      source: 'aks',
      subscriptionId: 'sub-shared',
      accountId: 'first@ptc.com',
      clusterName: 'shared-cluster',
    },
  ];
  upsertedSources = [];
  mergeResolvedNames = [];
  mergeDefaultName = 'shared-cluster';
  subscriptionsResult = [{ id: 'sub-shared', name: 'Shared Sub', isDefault: true }];
  tenantsResult = [];

  const session = makeTestSession({ userId: 'collision-test-user' });
  const res = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session }))
    .post('/api/azure/aks/credentials')
    .send({ resourceGroup: 'rg', name: 'shared-cluster', subscription: 'sub-shared', accountId: 'second@ptc.com' });

  assert.equal(res.status, 200);
  assert.equal(mergeResolvedNames.length, 1);
  assert.notEqual(mergeResolvedNames[0], 'shared-cluster', 'must not reuse the other account\'s context name');
  assert.match(mergeResolvedNames[0], /^shared-cluster--[0-9a-f]{8}$/);
  // ...and the new context is tagged to the importing account, leaving the first one intact.
  assert.equal(upsertedSources.at(-1)?.accountId, 'second@ptc.com');
  assert.equal(upsertedSources.at(-1)?.contextName, mergeResolvedNames[0]);

  contextSources = [];
});

test('POST /api/azure/aks/credentials reuses the same name when the SAME account re-imports', async () => {
  contextSources = [
    {
      contextName: 'my-cluster',
      scope: 'azure',
      source: 'aks',
      subscriptionId: 'sub-1',
      accountId: 'me@ptc.com',
      clusterName: 'my-cluster',
    },
  ];
  upsertedSources = [];
  mergeResolvedNames = [];
  mergeDefaultName = 'my-cluster';
  subscriptionsResult = [{ id: 'sub-1', name: 'Sub One', isDefault: true }];
  tenantsResult = [];

  const session = makeTestSession({ userId: 'reimport-test-user' });
  const res = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session }))
    .post('/api/azure/aks/credentials')
    .send({ resourceGroup: 'rg', name: 'my-cluster', subscription: 'sub-1', accountId: 'me@ptc.com' });

  assert.equal(res.status, 200);
  assert.deepEqual(mergeResolvedNames, ['my-cluster']);

  contextSources = [];
});

test('GET /api/azure/subscriptions does not leak one desktop user\'s cache to another', async () => {
  // The backend serves multiple desktop identities out of one process (see
  // desktopUserIdForEmail/runtimeByUserId in session.ts), so the subscriptions cache key must
  // include userId - not just scope + accountId - or two different users' 'local'-scope (no
  // accountId) requests collide on the same cache bucket and one sees the other's data.
  subscriptionsByConfigDir = {
    '/tmp/cache-user-a-local-azure': [{ id: 'sub-a', name: 'A only' }],
    '/tmp/cache-user-b-local-azure': [{ id: 'sub-b', name: 'B only' }],
  };

  const sessionA = makeTestSession({ userId: 'cache-user-a', localAzureConfigDir: '/tmp/cache-user-a-local-azure' });
  const resA = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session: sessionA }))
    .get('/api/azure/subscriptions?source=local');
  assert.deepEqual(resA.body, { subscriptions: [{ id: 'sub-a', name: 'A only' }] });

  const sessionB = makeTestSession({ userId: 'cache-user-b', localAzureConfigDir: '/tmp/cache-user-b-local-azure' });
  const resB = await request(buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session: sessionB }))
    .get('/api/azure/subscriptions?source=local');
  assert.deepEqual(resB.body, { subscriptions: [{ id: 'sub-b', name: 'B only' }] });

  subscriptionsByConfigDir = {};
});

test('GET /api/azure/login/status returns the login manager status', async () => {
  const session = makeTestSession({ azureLoginCloud: { getStatus: () => ({ state: 'signed-in' }) } as any });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).get('/api/azure/login/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'signed-in' });
});

test('POST /api/azure/accounts/disconnect removes tagged docs by accountId, with no subscriptions CLI round trip', async () => {
  contextSources = [
    { contextName: 'ctx-a', scope: 'azure', source: 'aks', accountId: 'me@ptc.com', subscriptionId: 'sub-1' },
    { contextName: 'ctx-b', scope: 'azure', source: 'aks', accountId: 'other@ptc.com', subscriptionId: 'sub-2' },
  ];
  removedContextNames = [];
  subscriptionsCallCount = 0;

  const res = await request(app()).post('/api/azure/accounts/disconnect').send({ email: 'me@ptc.com' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.removed, ['ctx-a']);
  assert.deepEqual(removedContextNames, ['ctx-a']);
  // Every source was already tagged, so ownership never needed a live `az account list` call.
  assert.equal(subscriptionsCallCount, 0);

  contextSources = [];
});

test('POST /api/azure/accounts/disconnect falls back to subscription ownership only for untagged legacy docs', async () => {
  // A mix of a legacy (pre-isolation) untagged doc and a doc already tagged for a DIFFERENT
  // account - the tagged one must never be swept up by the legacy subscription-name fallback,
  // and the untagged one must still be resolved via a live ownership lookup. `other-ctx` is
  // deliberately given the SAME subscriptionId the target account owns: if the fallback scan
  // were ever widened from `legacyUntagged` back to all `sources`, this id match would
  // incorrectly sweep it up too, so this proves the scoping, not just the id-matching.
  contextSources = [
    { contextName: 'legacy-ctx', scope: 'azure', source: 'aks', subscriptionName: 'Legacy Sub' },
    { contextName: 'other-ctx', scope: 'azure', source: 'aks', accountId: 'other@ptc.com', subscriptionId: 'sub-legacy' },
  ];
  subscriptionsResult = [{ id: 'sub-legacy', name: 'Legacy Sub', user: { name: 'me@ptc.com' } }];
  removedContextNames = [];
  subscriptionsCallCount = 0;

  const res = await request(app()).post('/api/azure/accounts/disconnect').send({ email: 'me@ptc.com' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.removed, ['legacy-ctx']);
  assert.deepEqual(removedContextNames, ['legacy-ctx']);
  assert.equal(subscriptionsCallCount, 1);

  contextSources = [];
  subscriptionsResult = [];
});

test('GET /api/azure/login/status giving up on finalize does not leave azureLoginCloud stuck reporting "succeeded" forever', async () => {
  // The underlying `az login` really did succeed - only OUR reconciliation-by-email failed
  // repeatedly (e.g. `az account show` never identifying a user). `azureLoginCloud` aliases
  // the same manager as `azureLoginCloudPending.manager` (as POST /login sets up), so once
  // finalize gives up and clears pending, a later no-pending poll must not fall back to that
  // manager's still-'succeeded' status - that would resurrect the exact "stuck loading
  // forever" hang this durable fallback exists to fix.
  accountShowResult = null;
  const stuckManager = {
    getStatus: () => ({ state: 'succeeded', message: 'Azure login succeeded.', deviceInfo: null, diagnostics: {} }),
  } as any;
  const session = makeTestSession({
    userId: 'giveup-user',
    azureLoginCloud: stuckManager,
    azureLoginCloudPending: {
      manager: stuckManager,
      configDirName: 'candidate-giveup',
      configDir: '/tmp/candidate-giveup',
      finalizeAttempts: 4, // one more failed attempt reaches LOGIN_FINALIZE_MAX_ATTEMPTS (5)
    },
  });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).get('/api/azure/login/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'failed');
  assert.equal(session.azureLoginCloudPending, null);

  const res2 = await request(scopedApp).get('/api/azure/login/status');
  assert.equal(res2.status, 200);
  assert.notEqual(res2.body.state, 'succeeded');

  accountShowResult = { user: { name: 'me@example.com' } };
});

test('POST /api/azure/login/cancel abandons a pending login without leaving azureLoginCloud stuck reporting "succeeded"', async () => {
  // Same hazard as the give-up path above, reached a different way: the user clicks Cancel
  // instead of the finalize retries being exhausted. `azureLoginCloud` aliases the same
  // manager as `azureLoginCloudPending.manager`, so a later no-pending poll must not see this
  // abandoned attempt's status - including 'succeeded', if `az login` finishes in the
  // background right after the user cancels.
  let cancelCalls = 0;
  const stuckManager = {
    cancel: () => {
      cancelCalls += 1;
    },
    getStatus: () => ({ state: 'succeeded', message: 'Azure login succeeded.', deviceInfo: null, diagnostics: {} }),
  } as any;
  const session = makeTestSession({
    userId: 'cancel-user',
    azureLoginCloud: stuckManager,
    azureLoginCloudPending: {
      manager: stuckManager,
      configDirName: 'candidate-cancel',
      configDir: '/tmp/candidate-cancel',
      finalizeAttempts: 0,
    },
  });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).post('/api/azure/login/cancel');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(cancelCalls, 1);
  assert.equal(session.azureLoginCloudPending, null);

  const status = await request(scopedApp).get('/api/azure/login/status');
  assert.notEqual(status.body.state, 'succeeded');
});

test('POST /api/azure/login/cancel with no pending attempt is a harmless no-op', async () => {
  const session = makeTestSession({ userId: 'cancel-noop-user', azureLoginCloudPending: null });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).post('/api/azure/login/cancel');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('POST /api/azure/login/cancel for local scope cancels that scope\'s own login manager', async () => {
  let cancelledWith: string | undefined;
  const localManager = { cancel: (reason?: string) => { cancelledWith = reason; }, getStatus: () => ({ state: 'idle' }) } as any;
  const session = makeTestSession({ azureLoginLocal: localManager });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).post('/api/azure/login/cancel?source=local');
  assert.equal(res.status, 200);
  assert.ok(cancelledWith);
});
