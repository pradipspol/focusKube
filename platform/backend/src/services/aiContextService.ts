import {
  type UserSessionState,
  activeSessionAzureConfigDir,
  activeSessionKubeconfigPath,
  resolveSessionAuthContext,
} from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { RESOURCE_KINDS, getResource, listResource } from '../kube/resources.js';
import { callK8s } from '../util/k8sError.js';
import { logWarn } from '../util/logger.js';

export interface ClusterContext {
  cluster: {
    context: string;
  };
  /** Cluster-wide counts, always included (not gated on a focused resource) so the
   * assistant can answer basic overview questions ("how many pods/deployments do I have")
   * without anything selected in the UI. */
  clusterSummary?: Array<{ kind: string; count: number }>;
  focusedResource?: {
    kind: string;
    namespace: string;
    name: string;
    yaml?: string;
  };
  relatedResources?: Array<{
    kind: string;
    namespace: string;
    name: string;
  }>;
  recentEvents?: Array<{
    type: string;
    reason: string;
    message: string;
    involvedObject: {
      kind: string;
      name: string;
      namespace: string;
    };
    firstTimestamp?: string;
    lastTimestamp?: string;
  }>;
}

/** Reverse lookup from a Kind (e.g. "Deployment") to its URL-plural resource name (e.g. "deployments"). */
const PLURAL_BY_KIND: Record<string, string> = Object.fromEntries(
  Object.values(RESOURCE_KINDS).map((rk) => [rk.kind, rk.plural]),
);

export class AiContextService {
  async assembleContext(
    userSession: UserSessionState,
    focusedResource?: {
      kind: string;
      namespace: string;
      name: string;
    },
    requestedContext?: string,
  ): Promise<ClusterContext> {
    const context = requestedContext || userSession.activeContext || 'default';

    const result: ClusterContext = {
      cluster: { context },
    };

    if (!userSession.activeContextSource) {
      return result;
    }

    let kubeOptions: { kubeconfigPath: string; fallbackContext: string | null; azureConfigDir: string };
    try {
      const kubeconfigPath = activeSessionKubeconfigPath(userSession, context);
      const azureConfigDir = await activeSessionAzureConfigDir(userSession, context);
      const { scope, identity } = await resolveSessionAuthContext(userSession, context);
      kubeOptions = {
        kubeconfigPath,
        fallbackContext: userSession.activeContext,
        azureConfigDir,
      };

      await ensureContextAuthReady({
        context,
        kubeconfigPath,
        fallbackContext: userSession.activeContext,
        azureConfigDir,
        source: scope,
        userId: userSession.userId,
        azureLogin: userSession.azureLogin,
        identity,
      });
    } catch (err) {
      logWarn('ai_context.assemble_partial', {
        context,
        error: err instanceof Error ? err.message : String(err),
      });
      // Can't reach the cluster at all this turn — bare cluster context only.
      return result;
    }

    // Cluster-wide counts, fetched regardless of whether a resource is focused — otherwise
    // basic overview questions ("how many pods/deployments") have nothing to answer from.
    result.clusterSummary = await buildClusterSummary(context, kubeOptions);

    if (!focusedResource) {
      return result;
    }

    const plural = PLURAL_BY_KIND[focusedResource.kind];
    if (!plural) {
      // Unknown/unsupported kind — return bare cluster context rather than failing the turn.
      logWarn('ai_context.unknown_kind', { kind: focusedResource.kind });
      return result;
    }

    result.focusedResource = {
      kind: focusedResource.kind,
      namespace: focusedResource.namespace,
      name: focusedResource.name,
    };

    // Fetch the resource YAML
    try {
      const resource = await callK8s(() =>
        getResource(plural, focusedResource.name, context, focusedResource.namespace, kubeOptions),
      );
      if (resource) {
        result.focusedResource.yaml = JSON.stringify(resource, null, 2);
      }
    } catch {
      // Continue without the resource YAML
    }

    // Fetch related resources (for a Deployment, fetch its Pods)
    if (focusedResource.kind === 'Deployment') {
      try {
        // listResource resolves to the items array directly, not a wrapper object.
        const pods = await callK8s(() =>
          listResource('pods', context, focusedResource.namespace, kubeOptions),
        );
        if (Array.isArray(pods)) {
          result.relatedResources = pods
            .filter((pod: any) => {
              const ownerRefs = pod.metadata?.ownerReferences || [];
              return ownerRefs.some(
                (ref: any) => ref.kind === 'Deployment' && ref.name === focusedResource.name,
              );
            })
            .map((pod: any) => ({
              kind: 'Pod',
              namespace: pod.metadata?.namespace,
              name: pod.metadata?.name,
            }))
            .slice(0, 10); // Limit to 10 related resources
        }
      } catch {
        // Continue without related resources
      }
    }

    // Fetch recent events involving the focused resource
    try {
      // listResource resolves to the items array directly, not a wrapper object.
      const events = await callK8s(() =>
        listResource('events', context, focusedResource.namespace, kubeOptions),
      );
      if (Array.isArray(events)) {
        result.recentEvents = events
          .filter((event: any) => {
            const involved = event.involvedObject || {};
            return involved.kind === focusedResource.kind && involved.name === focusedResource.name;
          })
          .sort((a: any, b: any) => {
            const aTime = new Date(a.lastTimestamp || a.firstTimestamp || 0).getTime();
            const bTime = new Date(b.lastTimestamp || b.firstTimestamp || 0).getTime();
            return bTime - aTime;
          })
          .slice(0, 10) // Limit to 10 recent events
          .map((event: any) => ({
            type: event.type,
            reason: event.reason,
            message: event.message,
            involvedObject: {
              kind: event.involvedObject?.kind,
              name: event.involvedObject?.name,
              namespace: event.involvedObject?.namespace,
            },
            firstTimestamp: event.firstTimestamp,
            lastTimestamp: event.lastTimestamp,
          }));
      }
    } catch {
      // Continue without events
    }

    return result;
  }
}

/** Common kinds a "how many X do I have" question is likely to ask about. Counts only (not
 * full listings) to keep the context payload small — kinds we can't list are simply omitted
 * rather than failing the whole turn. */
const SUMMARY_KINDS = ['pods', 'deployments', 'services', 'namespaces'];

async function buildClusterSummary(
  context: string,
  kubeOptions: { kubeconfigPath: string; fallbackContext: string | null; azureConfigDir: string },
): Promise<Array<{ kind: string; count: number }>> {
  const summary: Array<{ kind: string; count: number }> = [];
  for (const plural of SUMMARY_KINDS) {
    try {
      // listResource resolves to the items array directly, not a wrapper object.
      const list = await callK8s(() => listResource(plural, context, undefined, kubeOptions));
      if (Array.isArray(list)) {
        summary.push({ kind: plural, count: list.length });
      }
    } catch {
      // Skip kinds we couldn't list rather than failing the whole turn.
    }
  }
  return summary;
}

export const aiContextService = new AiContextService();
