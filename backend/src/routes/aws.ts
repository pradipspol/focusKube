import { Router } from 'express';
import { z } from 'zod';
import {
  awsListEks,
  awsSsoLogout,
  awsStsGetCallerIdentity,
  writeAwsRoleProfileConfig,
  writeAwsStaticProfileConfig,
  writeAwsSsoProfileConfig,
  awsUpdateEksKubeconfig,
  type AwsIdentity,
  type EksCluster,
} from '../aws/aws.js';
import { sessionEnv } from '../auth/session.js';
import { setSessionContextSourceHint } from '../auth/session.js';
import { kube } from '../kube/client.js';
import { removeContextsFromKubeconfigFile } from '../kube/kubeconfigFile.js';
import { badRequest } from '../util/httpError.js';
import { AsyncRefreshCache } from '../util/asyncCache.js';
import { setRequestOperation } from '../util/requestOp.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { invalidateContextsCache } from './contexts.js';
import {
  deleteDesktopContextSourcesForNames,
  listDesktopContextSources,
  upsertDesktopContextSource,
} from '../runtime/desktopStore.js';

export const awsRouter = Router();

const awsAccountCaches = new Map<string, AsyncRefreshCache<{ account: AwsIdentity | null }>>();
const awsEksCaches = new Map<string, AsyncRefreshCache<{ clusters: EksCluster[]; error?: string }>>();

function awsAccountCacheFor(req: any): AsyncRefreshCache<{ account: AwsIdentity | null }> {
  const cacheKey = req.userSession.userId;
  const existing = awsAccountCaches.get(cacheKey);
  if (existing) return existing;

  const created = new AsyncRefreshCache<{ account: AwsIdentity | null }>(`aws.account.${cacheKey}`);
  awsAccountCaches.set(cacheKey, created);
  return created;
}

function awsEksCacheFor(req: any): AsyncRefreshCache<{ clusters: EksCluster[]; error?: string }> {
  const cacheKey = req.userSession.userId;
  const existing = awsEksCaches.get(cacheKey);
  if (existing) return existing;

  const created = new AsyncRefreshCache<{ clusters: EksCluster[] }>(`aws.eks.${cacheKey}`);
  awsEksCaches.set(cacheKey, created);
  return created;
}

function invalidateAwsSessionCaches(req: any): void {
  awsAccountCacheFor(req).invalidate();
  awsEksCacheFor(req).invalidate();
}

awsRouter.get('/account', withRouteErrorLogging('aws', 'GET /account', async (req, res) => {
  setRequestOperation(req, 'aws.account.current');
  const cache = awsAccountCacheFor(req);
  res.json(
    await cache.get(
      () => awsStsGetCallerIdentity({ env: sessionEnv(req) }).then((account) => ({ account })),
      {
        // aws sts get-caller-identity spawns a real CLI process (typically 1-2s);
        // the default 100ms wait would almost always fall back to "not signed in"
        // even though the identity resolves a moment later in the background.
        waitMs: 8_000,
        fallback: () => ({ account: null }),
        onError: (err) => {
          // eslint-disable-next-line no-console
          console.warn('Failed to refresh AWS account cache:', err);
        },
      },
    ),
  );
}));

awsRouter.post('/login', withRouteErrorLogging('aws', 'POST /login', async (req, res) => {
  setRequestOperation(req, 'aws.login.start');
  invalidateAwsSessionCaches(req);
  const info = await req.userSession.awsLogin.start();
  res.json(info);
}));

awsRouter.post('/configure-auth', withRouteErrorLogging('aws', 'POST /configure-auth', async (req, res) => {
  setRequestOperation(req, 'aws.configure_auth');
  const body = z
    .discriminatedUnion('mode', [
      z.object({
        mode: z.literal('sso'),
        profileName: z.string().min(1),
        ssoSessionName: z.string().min(1).optional(),
        ssoStartUrl: z.string().url(),
        ssoRegion: z.string().min(1),
        accountId: z.string().min(1),
        roleName: z.string().min(1),
        region: z.string().min(1),
        output: z.string().min(1).optional(),
      }),
      z.object({
        mode: z.literal('static'),
        profileName: z.string().min(1),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        sessionToken: z.string().min(1).optional(),
        region: z.string().min(1),
        output: z.string().min(1).optional(),
      }),
      z.object({
        mode: z.literal('role'),
        profileName: z.string().min(1),
        roleArn: z.string().min(1),
        region: z.string().min(1),
        output: z.string().min(1).optional(),
        sourceProfileName: z.string().min(1).optional(),
        credentialSource: z.enum(['Environment', 'Ec2InstanceMetadata', 'EcsContainer']).optional(),
        roleSessionName: z.string().min(1).optional(),
      }),
    ])
    .safeParse(req.body);

  if (!body.success) {
    throw badRequest('Invalid AWS auth configuration');
  }

  if (body.data.mode === 'sso') {
    await writeAwsSsoProfileConfig(req.userSession.awsConfigFile, body.data);
  } else if (body.data.mode === 'static') {
    await writeAwsStaticProfileConfig(req.userSession.awsConfigFile, req.userSession.awsCredentialsFile, body.data);
  } else {
    await writeAwsRoleProfileConfig(req.userSession.awsConfigFile, body.data);
  }

  req.userSession.awsProfile = body.data.profileName;
  invalidateAwsSessionCaches(req);
  res.json({ ok: true, profileName: body.data.profileName, mode: body.data.mode });
}));

awsRouter.get('/login/status', withRouteErrorLogging('aws', 'GET /login/status', (req, res) => {
  setRequestOperation(req, 'aws.login.status');
  res.json(req.userSession.awsLogin.getStatus());
}));

awsRouter.post('/logout', withRouteErrorLogging('aws', 'POST /logout', async (req, res) => {
  setRequestOperation(req, 'aws.logout');
  await awsSsoLogout({ env: sessionEnv(req) });
  invalidateAwsSessionCaches(req);
  res.json({ ok: true });
}));

awsRouter.get('/eks', withRouteErrorLogging('aws', 'GET /eks', async (req, res) => {
  setRequestOperation(req, 'aws.eks.list');
  const cache = awsEksCacheFor(req);
  res.json(
    await cache.get(
      () => awsListEks({ env: sessionEnv(req) }),
      {
        waitMs: 60_000,
        fallback: () => ({ clusters: [] }),
        onError: (err) => {
          // eslint-disable-next-line no-console
          console.warn('Failed to refresh AWS EKS cache:', err);
        },
      },
    ),
  );
}));

awsRouter.post('/eks/credentials', withRouteErrorLogging('aws', 'POST /eks/credentials', async (req, res) => {
  setRequestOperation(req, 'aws.eks.credentials');
  const body = z
    .object({
      region: z.string().min(1),
      name: z.string().min(1),
    })
    .safeParse(req.body);
  if (!body.success) throw badRequest('region and name are required');

  const userId = req.authUser?.id;
  if (!userId) throw badRequest('Authentication required');

  const before = new Set(
    (await kube.getContexts(req.userSession.awsKubeconfigPath, req.userSession.activeContext)).map((ctx) => ctx.name),
  );

  await awsUpdateEksKubeconfig({
    region: body.data.region,
    name: body.data.name,
    alias: body.data.name,
    kubeconfigPath: req.userSession.awsKubeconfigPath,
    env: sessionEnv(req),
  });

  // EKS contexts used to be written into the shared Azure "cloud" kubeconfig; evict any
  // leftover entry with this name there so reconnecting doesn't produce a duplicate.
  await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, new Set([body.data.name]));

  invalidateAwsSessionCaches(req);

  const contexts = await kube.getContexts(req.userSession.awsKubeconfigPath, req.userSession.activeContext);
  const imported = contexts.filter((ctx) => !before.has(ctx.name));
  const contextCandidates = contexts.filter((ctx) => ctx.name === body.data.name);
  const contextsToTag = contextCandidates.length > 0 ? contextCandidates : imported;
  const activeContext =
    contextsToTag.find((ctx) => ctx.name === body.data.name)?.name ??
    contextsToTag[0]?.name ??
    req.userSession.activeContext;

  const accountIdentity = await awsStsGetCallerIdentity({ env: sessionEnv(req) });

  if (contextsToTag.length > 0) {
    for (const ctx of contextsToTag) {
      await upsertDesktopContextSource(userId, {
        contextName: ctx.name,
        source: 'eks',
        accountId: accountIdentity?.account,
        region: body.data.region,
        clusterName: body.data.name,
      });
    }
  }

  if (activeContext) {
    req.userSession.activeContext = activeContext;
    req.userSession.activeContextSource = 'aws';
    setSessionContextSourceHint(req.userSession, activeContext, 'aws');
  } else if (!req.userSession.activeContext && contexts.length > 0) {
    req.userSession.activeContext = contexts[0].name;
    req.userSession.activeContextSource = 'aws';
    setSessionContextSourceHint(req.userSession, contexts[0].name, 'aws');
  }

  invalidateContextsCache(req);
  res.json({ ok: true, active: req.userSession.activeContext ?? undefined, contexts });
}));
