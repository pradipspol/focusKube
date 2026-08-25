import { badRequest, notFound } from '../util/httpError.js';
import { getResource, listResource, replaceResource } from '../kube/resources.js';

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';

export type WorkloadKubeOptions = {
  kubeconfigPath?: string;
  fallbackContext?: string | null;
};

interface RevisionInfo {
  revision: number;
  rs: any;
}

function containerImages(rs: any): string[] {
  return (rs.spec?.template?.spec?.containers ?? []).map((c: any) => c.image);
}

async function getDeploymentRevisions(
  name: string,
  context: string | undefined,
  namespace: string,
  options: WorkloadKubeOptions,
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

export class WorkloadsService {
  requireNamespace(namespace?: string): string {
    if (!namespace) throw badRequest('namespace query parameter is required');
    return namespace;
  }

  async restartDeployment(
    name: string,
    namespace: string,
    context: string | undefined,
    options: WorkloadKubeOptions,
  ) {
    const dep: any = await getResource('deployments', name, context, namespace, options);
    dep.spec.template.metadata = dep.spec.template.metadata ?? {};
    dep.spec.template.metadata.annotations = dep.spec.template.metadata.annotations ?? {};
    dep.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();
    return replaceResource(dep, context, options);
  }

  async scaleDeployment(
    name: string,
    namespace: string,
    context: string | undefined,
    replicas: number,
    options: WorkloadKubeOptions,
  ) {
    const dep: any = await getResource('deployments', name, context, namespace, options);
    dep.spec.replicas = replicas;
    return replaceResource(dep, context, options);
  }

  async deploymentHistory(
    name: string,
    namespace: string,
    context: string | undefined,
    options: WorkloadKubeOptions,
  ) {
    const revisions = await getDeploymentRevisions(name, context, namespace, options);
    return {
      revisions: revisions.map((r) => ({
        revision: r.revision,
        name: r.rs.metadata.name,
        createdAt: r.rs.metadata.creationTimestamp,
        images: containerImages(r.rs),
      })),
    };
  }

  async rollbackDeployment(
    name: string,
    namespace: string,
    context: string | undefined,
    revision: number | undefined,
    options: WorkloadKubeOptions,
  ) {
    const revisions = await getDeploymentRevisions(name, context, namespace, options);
    if (revisions.length < 2) throw badRequest('No previous revision to roll back to');

    const target = revision
      ? revisions.find((r) => r.revision === revision)
      : revisions[revisions.length - 2];
    if (!target) throw notFound(`Revision ${revision} not found`);

    const dep: any = await getResource('deployments', name, context, namespace, options);
    const template = JSON.parse(JSON.stringify(target.rs.spec.template));
    if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
    dep.spec.template = template;
    dep.metadata.annotations = dep.metadata.annotations ?? {};
    dep.metadata.annotations['kubernetes.io/change-cause'] = `Rollback to revision ${target.revision}`;

    const updated = await replaceResource(dep, context, options);
    return { rolledBackTo: target.revision, deployment: updated };
  }
}

export const workloadsService = new WorkloadsService();