import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import {
  ensureScopedContextAuth,
  requestedContextFromQuery,
  requestedSourceFromQuery,
  resolveScopedRequestContext,
} from './requestContext.js';
import * as helmService from '../services/helmService.js';

export const helmRouter = Router();

function queryNamespace(req: any): string | undefined {
  return (req.query.namespace as string) || undefined;
}

/** List releases. Without a namespace, lists across all namespaces. */
helmRouter.get('/releases', withRouteErrorLogging('helm', 'GET /releases', async (req, res) => {
  setRequestOperation(req, 'helm.releases.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const releases = await helmService.listReleases(req.userSession, scoped, queryNamespace(req));
  res.json({ releases });
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
  await helmService.addRepo(req.userSession, scoped, body.data.name, body.data.url);
  res.json({ ok: true, name: body.data.name, url: body.data.url });
}));

helmRouter.get('/repos', withRouteErrorLogging('helm', 'GET /repos', async (req, res) => {
  setRequestOperation(req, 'helm.repos.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const repos = await helmService.listRepos(req.userSession, scoped);
  res.json({ repos });
}));

helmRouter.get('/charts', withRouteErrorLogging('helm', 'GET /charts', async (req, res) => {
  setRequestOperation(req, 'helm.charts.list');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const charts = await helmService.searchCharts(req.userSession, scoped);
  res.json({ charts });
}));

helmRouter.get('/releases/:name/history', withRouteErrorLogging('helm', 'GET /releases/:name/history', async (req, res) => {
  setRequestOperation(req, 'helm.release.history');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const history = await helmService.getReleaseHistory(req.userSession, scoped, req.params.name, queryNamespace(req) as string);
  res.json({ history });
}));

helmRouter.get('/releases/:name/values', withRouteErrorLogging('helm', 'GET /releases/:name/values', async (req, res) => {
  setRequestOperation(req, 'helm.release.values');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const values = await helmService.getReleaseValues(req.userSession, scoped, req.params.name, queryNamespace(req) as string);
  res.json({ values });
}));

helmRouter.get('/releases/:name/manifest', withRouteErrorLogging('helm', 'GET /releases/:name/manifest', async (req, res) => {
  setRequestOperation(req, 'helm.release.manifest');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const manifest = await helmService.getReleaseManifest(req.userSession, scoped, req.params.name, queryNamespace(req) as string);
  res.json({ manifest });
}));

helmRouter.post('/releases/:name/rollback', withRouteErrorLogging('helm', 'POST /releases/:name/rollback', async (req, res) => {
  setRequestOperation(req, 'helm.release.rollback');
  const body = z.object({ revision: z.number().int().positive() }).safeParse(req.body);
  if (!body.success) throw badRequest('revision (positive integer) is required');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);
  const output = await helmService.rollbackRelease(req.userSession, scoped, req.params.name, queryNamespace(req) as string, body.data.revision);
  res.json({ ok: true, output });
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
  const output = await helmService.installRelease(req.userSession, scoped, body.data);
  res.json({ ok: true, output });
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
  const output = await helmService.upgradeRelease(req.userSession, scoped, req.params.name, queryNamespace(req) as string, body.data);
  res.json({ ok: true, output });
});

helmRouter.get('/releases/:name/diff', async (req, res) => {
  setRequestOperation(req, 'helm.release.diff');
  const scoped = await resolveScopedRequestContext(req, {
    context: requestedContextFromQuery(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const revision = req.query.revision ? String(req.query.revision) : undefined;
  const diff = await helmService.diffRelease(req.userSession, scoped, req.params.name, queryNamespace(req) as string, revision);
  res.json(diff);
});

helmRouter.get('/charts/:name/values', async (req, res) => {
  setRequestOperation(req, 'helm.chart.values');
  const values = await helmService.getChartValues(req.params.name, req.query.version ? String(req.query.version) : undefined);
  res.json({ values });
});

helmRouter.delete('/releases/:name', async (req, res) => {
  setRequestOperation(req, 'helm.release.uninstall');
  const scoped = await resolveScopedRequestContext(req, {
    context: requestedContextFromQuery(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const output = await helmService.uninstallRelease(req.userSession, scoped, req.params.name, queryNamespace(req) as string);
  res.json({ ok: true, output });
});
