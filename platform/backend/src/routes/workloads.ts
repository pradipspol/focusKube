import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import {
  ensureScopedContextAuth,
  kubeOptionsForScope,
  requestedSourceFromQuery,
  resolveScopedRequestContext,
} from './requestContext.js';
import { workloadsService } from '../services/workloadsService.js';

export const workloadsRouter = Router();

const ctx = (req: any) => (req.query.context as string) || req.userSession.activeContext || undefined;

/** Restart a deployment by bumping the restartedAt annotation (like kubectl rollout restart). */
workloadsRouter.post('/deployments/:name/restart', withRouteErrorLogging('workloads', 'POST /deployments/:name/restart', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.restart');
  const namespace = workloadsService.requireNamespace((req.query.namespace as string) || undefined);
  const scoped = await resolveScopedRequestContext(req, {
    context: ctx(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const updated = await workloadsService.restartDeployment(
    req.params.name,
    namespace,
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );
  res.json(updated);
}));

/** Scale a deployment to a target replica count. */
workloadsRouter.post('/deployments/:name/scale', withRouteErrorLogging('workloads', 'POST /deployments/:name/scale', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.scale');
  const namespace = workloadsService.requireNamespace((req.query.namespace as string) || undefined);
  const body = z.object({ replicas: z.number().int().min(0).max(1000) }).safeParse(req.body);
  if (!body.success) throw badRequest('replicas (0-1000) is required');

  const scoped = await resolveScopedRequestContext(req, {
    context: ctx(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);

  const updated = await workloadsService.scaleDeployment(
    req.params.name,
    namespace,
    scoped.requestedContext,
    body.data.replicas,
    kubeOptionsForScope(req, scoped),
  );
  res.json(updated);
}));

/** Rollout history derived from owned ReplicaSets. */
workloadsRouter.get('/deployments/:name/history', withRouteErrorLogging('workloads', 'GET /deployments/:name/history', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.history');
  const namespace = workloadsService.requireNamespace((req.query.namespace as string) || undefined);
  const scoped = await resolveScopedRequestContext(req, {
    context: ctx(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const history = await workloadsService.deploymentHistory(
    req.params.name,
    namespace,
    scoped.requestedContext,
    kubeOptionsForScope(req, scoped),
  );
  res.json(history);
}));

/** Roll a deployment back to a previous revision (like kubectl rollout undo). */
workloadsRouter.post('/deployments/:name/rollback', withRouteErrorLogging('workloads', 'POST /deployments/:name/rollback', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.rollback');
  const namespace = workloadsService.requireNamespace((req.query.namespace as string) || undefined);
  const parsed = z
    .object({ revision: z.number().int().positive().optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('revision must be a positive integer');

  const scoped = await resolveScopedRequestContext(req, {
    context: ctx(req),
    source: requestedSourceFromQuery(req),
  });
  await ensureScopedContextAuth(req, scoped);
  const result = await workloadsService.rollbackDeployment(
    req.params.name,
    namespace,
    scoped.requestedContext,
    parsed.data.revision,
    kubeOptionsForScope(req, scoped),
  );
  res.json(result);
}));
