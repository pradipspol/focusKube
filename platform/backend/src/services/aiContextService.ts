import type { Request } from 'express';
import {
  type UserSessionState,
  activeSessionAzureConfigDir,
  activeSessionKubeconfigPath,
  resolveSessionAuthContext,
} from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { RESOURCE_KINDS, getResource, listResource, redactIfSensitive, resolveKind, stripReadNoise, type KubeAccessOptions } from '../kube/resources.js';
import { ensureScopedContextAuth, resolveScopedRequestContext, type ScopedRequestContext } from '../routes/requestContext.js';
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
  recentEvents?: RecentEvent[];
}

export interface RecentEvent {
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
}

export interface ResourceDetail {
  yaml?: string;
  relatedResources?: Array<{ kind: string; namespace: string; name: string }>;
  recentEvents?: RecentEvent[];
}

/** Reverse lookup from a Kind (e.g. "Deployment") to its URL-plural resource name (e.g. "deployments"). */
const PLURAL_BY_KIND: Record<string, string> = Object.fromEntries(
  Object.values(RESOURCE_KINDS).map((rk) => [rk.kind, rk.plural]),
);

/** Shared with aiToolExecutor.ts: a manifest's own `kind` field (e.g. "Deployment") is
 * capitalized singular, but kube/resources.ts's functions take the plural resource type. */
export function pluralForKind(kind: string): string | undefined {
  return PLURAL_BY_KIND[kind];
}

/** Resolves a session's live kubeconfig/auth for `context`, or null if the cluster can't be
 * reached this turn (no active context configured, or auth/readiness failed) — callers should
 * fall back to bare cluster info rather than failing the whole turn. Shared by assembleContext
 * (the UI's per-turn context) and aiToolExecutor's tool calls, which need the exact same
 * resolution — NOT routes/requestContext.ts's resolveScopedRequestContext, which expects an
 * Express Request with `.query` that a WebSocket upgrade request doesn't have. */
export async function resolveSessionKubeAccess(
  userSession: UserSessionState,
  context: string,
): Promise<KubeAccessOptions | null> {
  if (!userSession.activeContextSource) return null;

  try {
    const kubeconfigPath = activeSessionKubeconfigPath(userSession, context);
    const azureConfigDir = await activeSessionAzureConfigDir(userSession, context);
    const { scope, identity } = await resolveSessionAuthContext(userSession, context);
    const kubeOptions: KubeAccessOptions = {
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

    return kubeOptions;
  } catch (err) {
    logWarn('ai_context.kube_access_unavailable', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface HelmExecCtx {
  session: UserSessionState;
  scoped: ScopedRequestContext;
}

/** Helm tools shell out via the `helm` CLI (see services/helmService.ts), which needs the
 * session's full SessionScope-aware ScopedRequestContext — not just the KubeAccessOptions
 * resolveSessionKubeAccess above returns for the k8s SDK path. Builds just enough of an
 * Express Request shape (`.userSession`, `.authUser`, `.query.context`) for
 * resolveScopedRequestContext/ensureScopedContextAuth (routes/requestContext.ts) to work, since
 * those are the only fields either function actually touches — same rationale as
 * resolveSessionKubeAccess's own doc comment for why routes/requestContext.ts isn't used as-is
 * from a WebSocket handler. Returns null (not a thrown error) if scope/auth resolution fails,
 * matching resolveSessionKubeAccess's own fallback behavior. */
export async function resolveSessionHelmAccess(
  userSession: UserSessionState,
  context: string,
): Promise<HelmExecCtx | null> {
  try {
    const fakeReq = {
      userSession,
      authUser: { id: userSession.userId },
      query: { context },
    } as unknown as Request;
    const scoped = await resolveScopedRequestContext(fakeReq);
    await ensureScopedContextAuth(fakeReq, scoped);
    return { session: userSession, scoped };
  } catch (err) {
    logWarn('ai_context.helm_access_unavailable', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Recent Events, optionally filtered to one involved object. Shared by assembleContext (the
 * focused-resource case) and the get_events/describe_resource tools. */
export async function filterAndSortEvents(
  context: string,
  namespace: string | undefined,
  kubeOptions: KubeAccessOptions,
  filter?: { kind?: string; name?: string },
  limit = 10,
): Promise<RecentEvent[] | undefined> {
  try {
    // listResource resolves to the items array directly, not a wrapper object.
    const events = await callK8s(() => listResource('events', context, namespace, kubeOptions));
    if (!Array.isArray(events)) return undefined;
    return events
      .filter((event: any) => {
        const involved = event.involvedObject || {};
        if (filter?.kind && involved.kind !== filter.kind) return false;
        if (filter?.name && involved.name !== filter.name) return false;
        return true;
      })
      .sort((a: any, b: any) => {
        const aTime = new Date(a.lastTimestamp || a.firstTimestamp || 0).getTime();
        const bTime = new Date(b.lastTimestamp || b.firstTimestamp || 0).getTime();
        return bTime - aTime;
      })
      .slice(0, limit)
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
  } catch {
    return undefined;
  }
}

/** One resource's full manifest + (for a Deployment) its owned Pods + its recent Events —
 * the kubectl-describe-equivalent detail block. Shared by assembleContext (the UI's focused
 * resource) and the describe_resource tool. */
export async function buildResourceDetail(
  plural: string,
  namespace: string,
  name: string,
  context: string,
  kubeOptions: KubeAccessOptions,
): Promise<ResourceDetail> {
  const rk = resolveKind(plural);
  const detail: ResourceDetail = {};

  try {
    const resource = await callK8s(() => getResource(plural, name, context, namespace, kubeOptions));
    if (resource) {
      // Secret/ConfigMap values are redacted before they ever reach the assistant's context or
      // a tool result — both get rendered in chat AND re-sent to the LLM on every later turn,
      // a materially different exposure than the human-only, explicitly-gated secret reveal.
      detail.yaml = JSON.stringify(stripReadNoise(redactIfSensitive(resource, plural)), null, 2);
    }
  } catch {
    // Continue without the resource manifest
  }

  if (rk.kind === 'Deployment') {
    try {
      // listResource resolves to the items array directly, not a wrapper object.
      const pods = await callK8s(() => listResource('pods', context, namespace, kubeOptions));
      if (Array.isArray(pods)) {
        detail.relatedResources = pods
          .filter((pod: any) => {
            const ownerRefs = pod.metadata?.ownerReferences || [];
            return ownerRefs.some((ref: any) => ref.kind === 'Deployment' && ref.name === name);
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

  detail.recentEvents = await filterAndSortEvents(context, namespace, kubeOptions, { kind: rk.kind, name }, 10);

  return detail;
}

export class AiContextService {
  /** `precomputedKubeOptions` lets a caller that already resolved access for this same
   * context (e.g. ws/streams.ts's handleAiChat, which also needs it to build the AI tool
   * executor's context) pass it straight through instead of paying for
   * resolveSessionKubeAccess's real I/O — kubeconfig repair + Azure token-cache warm-up via
   * ensureContextAuthReady — a second time in the same turn. */
  async assembleContext(
    userSession: UserSessionState,
    focusedResource?: {
      kind: string;
      namespace: string;
      name: string;
    },
    requestedContext?: string,
    precomputedKubeOptions?: KubeAccessOptions | null,
  ): Promise<ClusterContext> {
    const context = requestedContext || userSession.activeContext || 'default';

    const result: ClusterContext = {
      cluster: { context },
    };

    const kubeOptions = precomputedKubeOptions !== undefined ? precomputedKubeOptions : await resolveSessionKubeAccess(userSession, context);
    if (!kubeOptions) {
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

    const detail = await buildResourceDetail(plural, focusedResource.namespace, focusedResource.name, context, kubeOptions);
    if (detail.yaml) result.focusedResource.yaml = detail.yaml;
    if (detail.relatedResources) result.relatedResources = detail.relatedResources;
    if (detail.recentEvents) result.recentEvents = detail.recentEvents;

    return result;
  }
}

/** Common kinds a "how many X do I have" question is likely to ask about. Counts only (not
 * full listings) to keep the context payload small — kinds we can't list are simply omitted
 * rather than failing the whole turn. */
const SUMMARY_KINDS = ['pods', 'deployments', 'services', 'namespaces'];

async function buildClusterSummary(
  context: string,
  kubeOptions: KubeAccessOptions,
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
