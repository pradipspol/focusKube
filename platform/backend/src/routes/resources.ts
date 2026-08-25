import { Router } from 'express';
import { z } from 'zod';
import { badRequest, withRouteErrorLogging } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import { config } from '../config.js';
import { logInfo } from '../util/logger.js';
import { resourcesService } from '../services/resourcesService.js';
import {
  ensureScopedContextAuth,
  kubeOptionsForScope,
  requestedContextFromQuery,
  resolveScopedRequestContext,
} from './requestContext.js';

export const resourcesRouter = Router();

const ns = (req: any) => (req.query.namespace as string) || undefined;

resourcesRouter.get('/_kinds', withRouteErrorLogging('resources', 'GET /_kinds', (req, res) => {
  setRequestOperation(req, 'resources.kinds.list');
  res.json(resourcesService.listKinds());
}));

resourcesRouter.post('/_validate', withRouteErrorLogging('resources', 'POST /_validate', async (req, res) => {
  setRequestOperation(req, 'resources.validate');
  const body = z.object({ yaml: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('yaml is required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const manifest = resourcesService.parseApplyManifest(body.data.yaml, ns(req));
  res.json({
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    name: manifest.metadata.name,
    namespace: manifest.metadata.namespace,
  });
}));

resourcesRouter.post('/_apply', withRouteErrorLogging('resources', 'POST /_apply', async (req, res) => {
  setRequestOperation(req, 'resources.apply');
  const body = z.object({ yaml: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('yaml is required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const manifest = resourcesService.parseApplyManifest(body.data.yaml, ns(req));
  const { object, created } = await resourcesService.applyResource(
    manifest,
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );

  res.status(created ? 201 : 200).json({ object, created });
}));

resourcesRouter.get('/pods/:name/metrics', withRouteErrorLogging('resources', 'GET /pods/:name/metrics', async (req, res) => {
  setRequestOperation(req, 'resources.pod.metrics');
  const namespace = ns(req);
  if (!namespace) throw badRequest('namespace query parameter is required');

  const scoped = await resolveScopedRequestContext(req);
  logInfo('resources.scope.selected', {
    reqId: req.logRequestId ?? null,
    operation: 'resources.pod.metrics',
    context: scoped.requestedContext,
    resolvedScope: scoped.selectedScope,
    activeContext: req.userSession.activeContext,
    activeContextSource: req.userSession.activeContextSource,
    kubeconfigPath: scoped.selectedKubeconfigPath,
    azureConfigDir: scoped.selectedAzureConfigDir,
  });

  await ensureScopedContextAuth(req, scoped);
  const snapshot = await resourcesService.getPodMetrics(
    req.params.name,
    namespace,
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );
  res.json(snapshot);
}));

resourcesRouter.post('/pods/metrics/batch', withRouteErrorLogging('resources', 'POST /pods/metrics/batch', async (req, res) => {
  setRequestOperation(req, 'resources.pod.metrics.batch');
  const pods = resourcesService.parseBatchPods(req.body);

  const scoped = await resolveScopedRequestContext(req);
  logInfo('resources.scope.selected', {
    reqId: req.logRequestId ?? null,
    operation: 'resources.pod.metrics.batch',
    context: scoped.requestedContext,
    resolvedScope: scoped.selectedScope,
    activeContext: req.userSession.activeContext,
    activeContextSource: req.userSession.activeContextSource,
    kubeconfigPath: scoped.selectedKubeconfigPath,
    azureConfigDir: scoped.selectedAzureConfigDir,
  });

  await ensureScopedContextAuth(req, scoped);
  const result = await resourcesService.getPodMetricsBatch(
    pods,
    ns(req),
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );
  res.json(result);
}));

resourcesRouter.get('/:plural', withRouteErrorLogging('resources', 'GET /:plural', async (req, res) => {
  setRequestOperation(req, 'resources.list');
  const scoped = await resolveScopedRequestContext(req, { context: requestedContextFromQuery(req) ?? req.userSession.activeContext ?? undefined });
  await ensureScopedContextAuth(req, scoped);

  const result = await resourcesService.listResources(
    req.params.plural,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
    {
      rawLimit: req.query.limit as string | undefined,
      rawContinue: req.query.continue as string | undefined,
      rawAttributes: req.query.attributes as string | undefined,
      selectedScope: scoped.selectedScope,
      selectedKubeconfigPath: scoped.selectedKubeconfigPath,
    },
  );

  res.json(result);
}));

resourcesRouter.get('/:plural/:name', withRouteErrorLogging('resources', 'GET /:plural/:name', async (req, res) => {
  setRequestOperation(req, 'resources.get');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const obj = await resourcesService.getResource(
    req.params.plural,
    req.params.name,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(obj);
}));

resourcesRouter.get('/:plural/:name/yaml', withRouteErrorLogging('resources', 'GET /:plural/:name/yaml', async (req, res) => {
  setRequestOperation(req, 'resources.yaml.get');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const result = await resourcesService.getResourceYaml(
    req.params.plural,
    req.params.name,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(result);
}));

resourcesRouter.put('/:plural/:name/yaml', withRouteErrorLogging('resources', 'PUT /:plural/:name/yaml', async (req, res) => {
  setRequestOperation(req, 'resources.yaml.replace');
  const body = z.object({ yaml: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('yaml is required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const updated = await resourcesService.replaceFromYaml(
    body.data.yaml,
    req.params.plural,
    req.params.name,
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );

  res.json(updated);
}));

resourcesRouter.delete('/:plural/:name', withRouteErrorLogging('resources', 'DELETE /:plural/:name', async (req, res) => {
  setRequestOperation(req, 'resources.delete');
  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const result = await resourcesService.deleteResource(
    req.params.plural,
    req.params.name,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(result);
}));

resourcesRouter.get('/secrets/:name/reveal', withRouteErrorLogging('resources', 'GET /secrets/:name/reveal', async (req, res) => {
  setRequestOperation(req, 'resources.secret.reveal');
  if (!config.allowSecretReveal) {
    throw badRequest('Secret reveal is disabled on this server (set ALLOW_SECRET_REVEAL=true).');
  }

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const result = await resourcesService.revealSecret(
    req.params.name,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(result);
}));

resourcesRouter.put('/configmaps/:name/data', withRouteErrorLogging('resources', 'PUT /configmaps/:name/data', async (req, res) => {
  setRequestOperation(req, 'resources.configmap.update_data');
  const body = z.object({ data: z.record(z.string()) }).safeParse(req.body);
  if (!body.success) throw badRequest('data map is required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const updated = await resourcesService.updateConfigMapData(
    req.params.name,
    body.data.data,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(updated);
}));

resourcesRouter.put('/secrets/:name/data', withRouteErrorLogging('resources', 'PUT /secrets/:name/data', async (req, res) => {
  setRequestOperation(req, 'resources.secret.update_data');
  const body = z.object({ data: z.record(z.string()) }).safeParse(req.body);
  if (!body.success) throw badRequest('data map is required');

  const scoped = await resolveScopedRequestContext(req);
  await ensureScopedContextAuth(req, scoped);

  const updated = await resourcesService.updateSecretData(
    req.params.name,
    body.data.data,
    scoped.requestedContext,
    ns(req),
    kubeOptionsForScope(req, scoped),
  );

  res.json(updated);
}));
