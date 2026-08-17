import { Router } from 'express';
import { z } from 'zod';
import { run, runOrThrow } from '../util/run.js';
import { kube } from '../kube/client.js';
import { badRequest } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import {
  azureConfigDirForSource,
  kubeconfigPathForSource,
  resolveSessionScopeForContext,
  sessionEnvForSource,
} from '../auth/session.js';

export const helmRouter = Router();

/** Build the common helm flags (kube context + namespace). */
async function helmFlags(req: any, namespaceRequired = false): Promise<string[]> {
  const flags: string[] = [];
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const context = await kube.resolveContextName((req.query.context as string) || undefined, {
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
  });
  if (context) flags.push('--kube-context', context);

  const namespace = (req.query.namespace as string) || undefined;
  if (namespace) flags.push('--namespace', namespace);
  else if (namespaceRequired) throw badRequest('namespace query parameter is required');
  return flags;
}

/** List releases. Without a namespace, lists across all namespaces. */
helmRouter.get('/releases', withRouteErrorLogging('helm', 'GET /releases', async (req, res) => {
  setRequestOperation(req, 'helm.releases.list');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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
  const args = ['list', '--output', 'json'];
  if (!req.query.namespace) args.push('--all-namespaces');
  args.push(...await helmFlags(req));
  const { stdout } = await runOrThrow('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  res.json({ releases: JSON.parse(stdout || '[]') });
}));

helmRouter.post('/repos', withRouteErrorLogging('helm', 'POST /repos', async (req, res) => {
  setRequestOperation(req, 'helm.repo.add');
  const body = z.object({
    name: z.string().min(1),
    url: z.string().url(),
  }).safeParse(req.body);
  if (!body.success) throw badRequest('Invalid repo request: name and url are required');

  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });

  const args = ['repo', 'add', body.data.name, body.data.url];
  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  if (result.code !== 0) throw badRequest('Failed to add Helm repository', (result.stderr || result.stdout).trim());
  res.json({ ok: true, name: body.data.name, url: body.data.url });
}));

helmRouter.get('/repos', withRouteErrorLogging('helm', 'GET /repos', async (req, res) => {
  setRequestOperation(req, 'helm.repos.list');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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

  const args = ['repo', 'list', '--output', 'json'];
  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  if (result.code !== 0) {
    res.json({ repos: [] });
    return;
  }
  res.json({ repos: JSON.parse(result.stdout || '[]') });
}));

helmRouter.get('/charts', withRouteErrorLogging('helm', 'GET /charts', async (req, res) => {
  setRequestOperation(req, 'helm.charts.list');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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
  const args = ['search', 'repo', '--output', 'json'];
  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });

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
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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
  const args = ['history', req.params.name, '--output', 'json', ...(await helmFlags(req, true))];
  const { stdout } = await runOrThrow('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  res.json({ history: JSON.parse(stdout || '[]') });
}));

helmRouter.get('/releases/:name/values', withRouteErrorLogging('helm', 'GET /releases/:name/values', async (req, res) => {
  setRequestOperation(req, 'helm.release.values');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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
  const args = ['get', 'values', req.params.name, '--output', 'yaml', ...(await helmFlags(req, true))];
  const { stdout } = await runOrThrow('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  res.json({ values: stdout });
}));

helmRouter.get('/releases/:name/manifest', withRouteErrorLogging('helm', 'GET /releases/:name/manifest', async (req, res) => {
  setRequestOperation(req, 'helm.release.manifest');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
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
  const args = ['get', 'manifest', req.params.name, ...(await helmFlags(req, true))];
  const { stdout } = await runOrThrow('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  res.json({ manifest: stdout });
}));

helmRouter.post('/releases/:name/rollback', withRouteErrorLogging('helm', 'POST /releases/:name/rollback', async (req, res) => {
  setRequestOperation(req, 'helm.release.rollback');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  const body = z.object({ revision: z.number().int().positive() }).safeParse(req.body);
  if (!body.success) throw badRequest('revision (positive integer) is required');
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });
  const args = [
    'rollback',
    req.params.name,
    String(body.data.revision),
    '--wait',
    ...(await helmFlags(req, true)),
  ];
  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
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

  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });

  const args = ['install', body.data.releaseName, body.data.chart, '--namespace', body.data.namespace];
  if (body.data.version) args.push('--version', body.data.version);
  if (body.data.values) args.push('--values', '/dev/stdin');
  args.push(...(await helmFlags(req)));

  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
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

  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });

  // Get current release info to find the chart name
  const releaseHistory = await runOrThrow('helm', ['history', req.params.name, '--max', '1', '--output', 'json', ...(await helmFlags(req, true))], {
    env: sessionEnvForSource(req, selectedScope),
  });
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
  args.push(...(await helmFlags(req, true)));

  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
    input: body.data.values || undefined,
  });
  if (result.code !== 0) throw badRequest('Helm upgrade failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
});

helmRouter.get('/releases/:name/diff', async (req, res) => {
  setRequestOperation(req, 'helm.release.diff');
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });

  const currentManifest = await runOrThrow('helm', ['get', 'manifest', req.params.name, ...(await helmFlags(req, true))], {
    env: sessionEnvForSource(req, selectedScope),
  });

  const comparisonRevision = req.query.revision ? String(req.query.revision) : undefined;
  if (!comparisonRevision) {
    res.json({ currentManifest: currentManifest.stdout, comparisonManifest: '' });
    return;
  }

  const comparisonManifest = await runOrThrow('helm', ['get', 'manifest', req.params.name, '--revision', comparisonRevision, ...(await helmFlags(req, true))], {
    env: sessionEnvForSource(req, selectedScope),
  });

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
  const requestedContext = (req.query.context as string) || undefined;
  const requestedSource = (req.query.source as string) || undefined;
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
  });
  const args = ['uninstall', req.params.name, ...(await helmFlags(req, true))];
  const result = await run('helm', args, {
    env: sessionEnvForSource(req, selectedScope),
  });
  if (result.code !== 0) throw badRequest('Helm uninstall failed', (result.stderr || result.stdout).trim());
  res.json({ ok: true, output: (result.stdout || result.stderr).trim() });
});
