import { Router } from 'express';
import { z } from 'zod';
import { run, runOrThrow, type RunOptions, type RunResult } from '../util/run.js';
import { kube } from '../kube/client.js';
import { withCliKubeconfig } from '../kube/cliKubeconfig.js';
import { badRequest } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import { sessionEnvForSource } from '../auth/session.js';
import {
  ensureScopedContextAuth,
  requestedContextFromQuery,
  requestedSourceFromQuery,
  resolveScopedRequestContext,
} from './requestContext.js';

export const helmRouter = Router();

/** Build the common helm flags (kube context + namespace). */
async function helmFlags(req: any, scoped: Awaited<ReturnType<typeof resolveScopedRequestContext>>, namespaceRequired = false): Promise<string[]> {
  const flags: string[] = [];
  const context = await kube.resolveContextName(scoped.requestedContext, {
    kubeconfigPath: scoped.selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
  });
  if (context) flags.push('--kube-context', context);

  const namespace = (req.query.namespace as string) || undefined;
  if (namespace) flags.push('--namespace', namespace);
  else if (namespaceRequired) throw badRequest('namespace query parameter is required');
  return flags;
}

async function withHelmKubeconfig<T>(
  req: any,
  scoped: Awaited<ReturnType<typeof resolveScopedRequestContext>>,
  action: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  return withCliKubeconfig(
    {
      session: req.userSession,
      context: scoped.requestedContext,
      source: scoped.selectedScope,
      env: sessionEnvForSource(req, scoped.selectedScope),
    },
    (env) => action(env),
  );
}

async function runHelm(
  req: any,
  scoped: Awaited<ReturnType<typeof resolveScopedRequestContext>>,
  args: string[],
  options: Omit<RunOptions, 'env'> = {},
): Promise<RunResult> {
  return withHelmKubeconfig(req, scoped, (env) => run('helm', args, { identity: scoped.identity, ...options, env }));
}

async function runHelmOrThrow(
  req: any,
  scoped: Awaited<ReturnType<typeof resolveScopedRequestContext>>,
  args: string[],
  options: Omit<RunOptions, 'env'> = {},
): Promise<RunResult> {
  return withHelmKubeconfig(req, scoped, (env) => runOrThrow('helm', args, { identity: scoped.identity, ...options, env }));
}

/** List releases. Without a namespace, lists across all namespaces. */
helmRouter.get('/releases', withRouteErrorLogging('helm', 'GET /releases', async (req, res) => {
  setRequestOperation(req, 'helm.releases.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = ['list', '--output', 'json'];
  if (!req.query.namespace) args.push('--all-namespaces');
  args.push(...await helmFlags(req, scoped));
  const { stdout } = await runHelmOrThrow(req, scoped, args);
  res.json({ releases: JSON.parse(stdout || '[]') });
}));

helmRouter.post('/repos', withRouteErrorLogging('helm', 'POST /repos', async (req, res) => {
  setRequestOperation(req, 'helm.repo.add');
  const body = z.object({
    name: z.string().min(1),
    url: z.string().url(),
  }).safeParse(req.body);
  if (!body.success) throw badRequest('Invalid repo request: name and url are required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const args = ['repo', 'add', body.data.name, body.data.url];
  const result = await runHelm(req, scoped, args);
  if (result.code !== 0) throw badRequest('Failed to add Helm repository', (result.stderr || result.stdout).trim());
  res.json({ ok: true, name: body.data.name, url: body.data.url });
}));

helmRouter.get('/repos', withRouteErrorLogging('helm', 'GET /repos', async (req, res) => {
  setRequestOperation(req, 'helm.repos.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const args = ['repo', 'list', '--output', 'json'];
  const result = await runHelm(req, scoped, args);
  if (result.code !== 0) {
    res.json({ repos: [] });
    return;
  }
  res.json({ repos: JSON.parse(result.stdout || '[]') });
}));

helmRouter.get('/charts', withRouteErrorLogging('helm', 'GET /charts', async (req, res) => {
  setRequestOperation(req, 'helm.charts.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = ['search', 'repo', '--output', 'json'];
  const result = await runHelm(req, scoped, args);

  // "no repositories to show" should not be a hard error for the UI.
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    if (/no repositories to show/i.test(details)) {
      res.json({ charts: [] });
      return;
    }
    throw badRequest('Helm charts lookup failed', details);
  }

  res.json({ charts: JSON.parse(result.stdout || '[]') });
}));

helmRouter.get('/releases/:name/history', withRouteErrorLogging('helm', 'GET /releases/:name/history', async (req, res) => {
  setRequestOperation(req, 'helm.release.history');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = ['history', req.params.name, '--output', 'json', ...(await helmFlags(req, scoped, true))];
  const { stdout } = await runHelmOrThrow(req, scoped, args);
  res.json({ history: JSON.parse(stdout || '[]') });
}));

helmRouter.get('/releases/:name/values', withRouteErrorLogging('helm', 'GET /releases/:name/values', async (req, res) => {
  setRequestOperation(req, 'helm.release.values');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = ['get', 'values', req.params.name, '--output', 'yaml', ...(await helmFlags(req, scoped, true))];
  const { stdout } = await runHelmOrThrow(req, scoped, args);
  res.json({ values: stdout });
}));

helmRouter.get('/releases/:name/manifest', withRouteErrorLogging('helm', 'GET /releases/:name/manifest', async (req, res) => {
  setRequestOperation(req, 'helm.release.manifest');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = ['get', 'manifest', req.params.name, ...(await helmFlags(req, scoped, true))];
  const { stdout } = await runHelmOrThrow(req, scoped, args);
  res.json({ manifest: stdout });
}));

helmRouter.post('/releases/:name/rollback', withRouteErrorLogging('helm', 'POST /releases/:name/rollback', async (req, res) => {
  setRequestOperation(req, 'helm.release.rollback');
  const body = z.object({ revision: z.number().int().positive() }).safeParse(req.body);
  if (!body.success) throw badRequest('revision (positive integer) is required');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const args = [
    'rollback',
    req.params.name,
    String(body.data.revision),
    '--wait',
    ...(await helmFlags(req, scoped, true)),
  ];
  const result = await runHelm(req, scoped, args);
  if (result.code !== 0) throw badRequest('Helm rollback failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
}));

helmRouter.post('/releases', withRouteErrorLogging('helm', 'POST /releases', async (req, res) => {
  setRequestOperation(req, 'helm.release.install');
  const body = z.object({
    chart: z.string(),
    releaseName: z.string(),
    namespace: z.string(),
    values: z.string().optional(),
    version: z.string().optional(),
  }).safeParse(req.body);
  if (!body.success) throw badRequest('Invalid install request');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const args = ['install', body.data.releaseName, body.data.chart, '--namespace', body.data.namespace];
  if (body.data.version) args.push('--version', body.data.version);
  if (body.data.values) args.push('--values', '/dev/stdin');
  args.push(...(await helmFlags(req, scoped)));

  const result = await runHelm(req, scoped, args, {
    input: body.data.values || undefined,
  });
  if (result.code !== 0) throw badRequest('Helm install failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
}));

helmRouter.post('/releases/:name', async (req, res) => {
  setRequestOperation(req, 'helm.release.upgrade');
  const body = z.object({
    values: z.string().optional(),
    version: z.string().optional(),
  }).safeParse(req.body);
  if (!body.success) throw badRequest('Invalid upgrade request');

  const scoped = await resolveScopedRequestContext(req, {
    context: requestedContextFromQuery(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);

  // Get current release info to find the chart name
  const releaseHistory = await runHelmOrThrow(req, scoped, ['history', req.params.name, '--max', '1', '--output', 'json', ...(await helmFlags(req, scoped, true))]);
  const history = JSON.parse(releaseHistory.stdout || '[]');
  if (history.length === 0) throw badRequest('Release not found');

  const chart = history[0].chart;
  const chartName = chart.split('-').slice(0, -1).join('-');

  const args = ['upgrade', req.params.name, chartName];
  if (body.data.version) args.push('--version', body.data.version);
  args.push('--reuse-values', '--wait');
  if (body.data.values) {
    args.splice(args.indexOf('--reuse-values'), 1); // remove --reuse-values if we're providing new values
    args.push('--values', '/dev/stdin');
  }
  args.push(...(await helmFlags(req, scoped, true)));

  const result = await runHelm(req, scoped, args, {
    input: body.data.values || undefined,
  });
  if (result.code !== 0) throw badRequest('Helm upgrade failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
});

helmRouter.get('/releases/:name/diff', async (req, res) => {
  setRequestOperation(req, 'helm.release.diff');
  const scoped = await resolveScopedRequestContext(req, {
    context: requestedContextFromQuery(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);

  const currentManifest = await runHelmOrThrow(req, scoped, ['get', 'manifest', req.params.name, ...(await helmFlags(req, scoped, true))]);

  const comparisonRevision = req.query.revision ? String(req.query.revision) : undefined;
  if (!comparisonRevision) {
    res.json({ currentManifest: currentManifest.stdout, comparisonManifest: '' });
    return;
  }

  const comparisonManifest = await runHelmOrThrow(req, scoped, ['get', 'manifest', req.params.name, '--revision', comparisonRevision, ...(await helmFlags(req, scoped, true))]);

  res.json({ currentManifest: currentManifest.stdout, comparisonManifest: comparisonManifest.stdout });
});

helmRouter.get('/charts/:name/values', async (req, res) => {
  setRequestOperation(req, 'helm.chart.values');
  const args = ['show', 'values', req.params.name];
  if (req.query.version) args.push('--version', String(req.query.version));

  const result = await run('helm', args);
  if (result.code !== 0) throw badRequest('Failed to fetch chart values', (result.stderr || result.stdout).trim());
  res.json({ values: result.stdout || '' });
});

helmRouter.delete('/releases/:name', async (req, res) => {
  setRequestOperation(req, 'helm.release.uninstall');
  const scoped = await resolveScopedRequestContext(req, {
    context: requestedContextFromQuery(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const args = ['uninstall', req.params.name, ...(await helmFlags(req, scoped, true))];
  const result = await runHelm(req, scoped, args);
  if (result.code !== 0) throw badRequest('Helm uninstall failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
});
