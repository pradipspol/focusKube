import { Router } from 'express';
import { z } from 'zod';
import { getResource, listResource, replaceResource } from '../kube/resources.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { badRequest, notFound } from '../util/httpError.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import {
  azureConfigDirForSource,
  kubeconfigPathForSource,
  resolveSessionScopeForContext,
} from '../auth/session.js';
import { setRequestOperation } from '../util/requestOp.js';

export const workloadsRouter = Router();

const ctx = (req: any) => (req.query.context as string) || req.userSession.activeContext || undefined;
const requestedSource = (req: any) => (req.query.source as string) || undefined;
const kubeOpts = (req: any, kubeconfigPath: string) => ({
  kubeconfigPath,
  fallbackContext: req.userSession.activeContext,
});
const requireNs = (req: any) => {
  const ns = (req.query.namespace as string) || undefined;
  if (!ns) throw badRequest('namespace query parameter is required');
  return ns;
};

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';

/** Restart a deployment by bumping the restartedAt annotation (like kubectl rollout restart). */
workloadsRouter.post('/deployments/:name/restart', withRouteErrorLogging('workloads', 'POST /deployments/:name/restart', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.restart');
  const namespace = requireNs(req);
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
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
  const dep: any = await getResource('deployments', req.params.name, requestedContext, namespace, kubeOpts(req, selectedKubeconfigPath));
  dep.spec.template.metadata = dep.spec.template.metadata ?? {};
  dep.spec.template.metadata.annotations = dep.spec.template.metadata.annotations ?? {};
  dep.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] =
    new Date().toISOString();
  const updated = await replaceResource(dep, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json(updated);
}));

/** Scale a deployment to a target replica count. */
workloadsRouter.post('/deployments/:name/scale', withRouteErrorLogging('workloads', 'POST /deployments/:name/scale', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.scale');
  const namespace = requireNs(req);
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  const body = z.object({ replicas: z.number().int().min(0).max(1000) }).safeParse(req.body);
  if (!body.success) throw badRequest('replicas (0-1000) is required');

  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });

  const dep: any = await getResource('deployments', req.params.name, requestedContext, namespace, kubeOpts(req, selectedKubeconfigPath));
  dep.spec.replicas = body.data.replicas;
  const updated = await replaceResource(dep, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json(updated);
}));

/** Rollout history derived from owned ReplicaSets. */
workloadsRouter.get('/deployments/:name/history', withRouteErrorLogging('workloads', 'GET /deployments/:name/history', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.history');
  const namespace = requireNs(req);
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
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
  const revisions = await getDeploymentRevisions(req.params.name, requestedContext, namespace, kubeOpts(req, selectedKubeconfigPath));
  res.json({
    revisions: revisions.map((r) => ({
      revision: r.revision,
      name: r.rs.metadata.name,
      createdAt: r.rs.metadata.creationTimestamp,
      images: containerImages(r.rs),
    })),
  });
}));

/** Roll a deployment back to a previous revision (like kubectl rollout undo). */
workloadsRouter.post('/deployments/:name/rollback', withRouteErrorLogging('workloads', 'POST /deployments/:name/rollback', async (req, res) => {
  setRequestOperation(req, 'workloads.deployment.rollback');
  const namespace = requireNs(req);
  const requestedContext = ctx(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource(req));
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);
  const parsed = z
    .object({ revision: z.number().int().positive().optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('revision must be a positive integer');

  await ensureContextAuthReady({
    context: requestedContext,
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: selectedAzureConfigDir,
    source: selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });

  const revisions = await getDeploymentRevisions(req.params.name, requestedContext, namespace, kubeOpts(req, selectedKubeconfigPath));
  if (revisions.length < 2) throw badRequest('No previous revision to roll back to');

  // Default to the revision just before the current (highest) one.
  const target = parsed.data.revision
    ? revisions.find((r) => r.revision === parsed.data.revision)
    : revisions[revisions.length - 2];
  if (!target) throw notFound(`Revision ${parsed.data.revision} not found`);

  const dep: any = await getResource('deployments', req.params.name, requestedContext, namespace, kubeOpts(req, selectedKubeconfigPath));
  // Copy the pod template from the target ReplicaSet, stripping the generated hash.
  const template = JSON.parse(JSON.stringify(target.rs.spec.template));
  if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
  dep.spec.template = template;
  dep.metadata.annotations = dep.metadata.annotations ?? {};
  dep.metadata.annotations['kubernetes.io/change-cause'] = `Rollback to revision ${target.revision}`;

  const updated = await replaceResource(dep, requestedContext, kubeOpts(req, selectedKubeconfigPath));
  res.json({ rolledBackTo: target.revision, deployment: updated });
}));

interface RevisionInfo {
  revision: number;
  rs: any;
}

async function getDeploymentRevisions(
  name: string,
  context: string | undefined,
  namespace: string,
  options: { kubeconfigPath?: string; fallbackContext?: string | null },
): Promise<RevisionInfo[]> {
  const dep: any = await getResource('deployments', name, context, namespace, options);
  const uid = dep.metadata?.uid;
  const replicaSets: any[] = await listResource('replicasets', context, namespace, options);

  return replicaSets
    .filter((rs) =>
      (rs.metadata?.ownerReferences ?? []).some(
        (o: any) => o.kind === 'Deployment' && (o.uid === uid || o.name === name),
      ),
    )
    .map((rs) => ({
      revision: parseInt(rs.metadata?.annotations?.[REVISION_ANNOTATION] ?? '0', 10),
      rs,
    }))
    .filter((r) => r.revision > 0)
    .sort((a, b) => a.revision - b.revision);
}

function containerImages(rs: any): string[] {
  return (rs.spec?.template?.spec?.containers ?? []).map((c: any) => c.image);
}
