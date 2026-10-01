import { type Role, hasCapability } from '../auth/rbac.js';
import {
  applyManifest,
  deleteResource,
  getResource,
  listResource,
  redactIfSensitive,
  sanitizeForEdit,
  stripReadNoise,
  type KubeAccessOptions,
} from '../kube/resources.js';
import { fetchDeploymentLogsOnce, fetchPodLogsOnce } from '../kube/podLogsOnce.js';
import { badRequest, HttpError } from '../util/httpError.js';
import { describeK8sError } from '../util/k8sError.js';
import { buildResourceDetail, filterAndSortEvents, pluralForKind, type HelmExecCtx } from './aiContextService.js';
import { workloadsService } from './workloadsService.js';
import { resourcesService } from './resourcesService.js';
import { aiService } from './aiService.js';
import * as helmService from './helmService.js';

const HELM_ACCESS_UNAVAILABLE = 'Helm access is not currently available for this connection.';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolExecCtx {
  context: string;
  kubeOptions: KubeAccessOptions;
  role: Role;
  /** Null when Helm access couldn't be resolved this turn (see
   * aiContextService.ts's resolveSessionHelmAccess) — Helm tool calls fail cleanly with
   * HELM_ACCESS_UNAVAILABLE rather than that blocking the rest of the turn's k8s tools. */
  helm: HelmExecCtx | null;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface ActionProposal {
  summary: string;
  /** Set when the requested create operation must not proceed to user approval. */
  blocked?: string;
  /** Populated only for apply_manifest — the user should see what changes, not a blind manifest. */
  diff?: { before?: string; after: string };
}

// The full `messages` array (including every prior tool result) is resent to the relay on
// every subsequent round-trip within a turn — an uncapped tool result would compound cost
// turn over turn, so every tool result is capped here before it goes back to either the model
// or the browser. list_resources' output is now a compact per-item summary rather than raw
// manifests, and get_resource/describe_resource strip the biggest raw-manifest bloat
// (managedFields, the last-applied-configuration annotation — see stripReadNoise) — but a
// single Pod's manifest alone can still sit right around the old 8KB ceiling (confirmed against
// a real cluster: ~8.4KB after stripping), so the cap is doubled rather than left tight enough
// to still truncate a single unremarkable object mid-JSON.
const MAX_TOOL_OUTPUT_CHARS = 16 * 1024;

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const remaining = text.length - MAX_TOOL_OUTPUT_CHARS;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated, ${remaining} more characters)`;
}

function ok(text: string): ToolResult {
  return { output: capOutput(text), isError: false };
}

// capOutput's char-level slice is fine for prose (logs) and safe to fall back to raw text for
// a single object, but for a JSON *array* — every list-shaped tool result — slicing mid-item
// produces invalid JSON, which silently loses the table view on the frontend (ToolOutputViewer
// can no longer JSON.parse it) and shows the user a truncated JSON dump instead. This trims
// whole items off the end instead, so the result is always valid, always-tabular JSON, with a
// final synthetic row noting how many items were left out.
export function okList(items: unknown[]): ToolResult {
  const full = JSON.stringify(items, null, 2);
  if (full.length <= MAX_TOOL_OUTPUT_CHARS) return { output: full, isError: false };

  const noteFor = (omitted: number) => ({
    name: `… ${omitted} more item(s) truncated — narrow with a namespace, or ask about a specific resource`,
  });
  const fits = (kept: number) => JSON.stringify([...items.slice(0, kept), noteFor(items.length - kept)], null, 2).length <= MAX_TOOL_OUTPUT_CHARS;

  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { output: JSON.stringify([...items.slice(0, lo), noteFor(items.length - lo)], null, 2), isError: false };
}

async function fail(err: unknown): Promise<ToolResult> {
  return { output: await describeK8sError(err), isError: true };
}

function clampTailLines(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 200;
  return Math.min(Math.max(n, 1), 1000);
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 20;
  return Math.min(Math.max(n, 1), 50);
}

// listResource() returns full raw manifests (spec, status, metadata.managedFields, the
// last-applied-configuration annotation, ...) — for a Pod alone that's routinely several KB,
// so any list beyond a handful of items blew past MAX_TOOL_OUTPUT_CHARS, got truncated
// mid-object by capOutput, and arrived at the frontend as invalid JSON (falling back to a raw
// text dump instead of a table) — and even un-truncated, a table keyed by top-level object
// keys (apiVersion/kind/metadata/spec/status) rendered giant JSON blobs as cells instead of
// anything readable. list_resources is a listing tool (get_resource is where a caller asks for
// the full manifest of one item), so it summarizes down to the kubectl-get-style fields callers
// actually ask about instead of returning the raw object. Secrets/ConfigMaps already come back
// pre-sanitized (no data) from listResource itself and are left as-is.
function summarizeForList(item: any, plural: string): any {
  if (plural === 'secrets' || plural === 'configmaps') return item;

  const summary: Record<string, unknown> = {
    name: item?.metadata?.name,
    ...(item?.metadata?.namespace ? { namespace: item.metadata.namespace } : {}),
    age: item?.metadata?.creationTimestamp,
  };
  const labels = item?.metadata?.labels;
  if (labels && Object.keys(labels).length > 0) summary.labels = labels;

  if (plural === 'pods') {
    const containerStatuses = (item?.status?.containerStatuses ?? []) as Array<{ ready?: boolean; restartCount?: number }>;
    summary.status = item?.status?.phase;
    summary.ready = `${containerStatuses.filter((c) => c.ready).length}/${containerStatuses.length}`;
    summary.restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
    if (item?.spec?.nodeName) summary.node = item.spec.nodeName;
  } else if (plural === 'deployments' || plural === 'statefulsets' || plural === 'replicasets' || plural === 'daemonsets') {
    summary.desiredReplicas = item?.spec?.replicas;
    summary.readyReplicas = item?.status?.readyReplicas ?? 0;
    summary.availableReplicas = item?.status?.availableReplicas ?? 0;
  } else if (plural === 'services') {
    summary.type = item?.spec?.type;
    summary.clusterIP = item?.spec?.clusterIP;
    summary.ports = ((item?.spec?.ports ?? []) as Array<{ port: number; nodePort?: number; protocol?: string }>)
      .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
      .join(', ');
  } else if (typeof item?.status?.phase === 'string') {
    summary.status = item.status.phase;
  } else if (Array.isArray(item?.status?.conditions) && item.status.conditions.length > 0) {
    const last = item.status.conditions[item.status.conditions.length - 1];
    summary.status = `${last.type}=${last.status}`;
  }
  return summary;
}

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'list_resources',
    description:
      'List Kubernetes resources of one kind (e.g. pods, deployments, services), optionally scoped to a namespace. By default returns a compact kubectl-get-style summary per item (name, status, replica/ready counts, etc.) — call get_resource for one item\'s complete manifest, or pass full:true here if the user explicitly asked for the complete raw manifest of every item in the list (a large list in full detail may be truncated).',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Resource type, plural form (e.g. "pods", "deployments", "services", "configmaps", "secrets").' },
        namespace: { type: 'string', description: 'Namespace to scope the list to. Omit to list across all namespaces (for namespaced kinds).' },
        full: { type: 'boolean', description: 'Return each item\'s complete raw manifest instead of the compact summary. Only set this when the user explicitly asked for full/complete/raw JSON.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'get_resource',
    description: "Fetch one Kubernetes resource's full manifest by kind and name.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Resource type, plural form (e.g. "pods", "deployments").' },
        name: { type: 'string', description: 'Resource name.' },
        namespace: { type: 'string', description: 'Namespace (required for namespaced kinds).' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'describe_resource',
    description:
      "kubectl describe-equivalent: a resource's manifest, plus (for a Deployment) its owned Pods and its recent Events.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Resource type, plural form (e.g. "deployments", "pods").' },
        name: { type: 'string', description: 'Resource name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['kind', 'name', 'namespace'],
    },
  },
  {
    name: 'get_logs',
    description:
      'Tail logs for a Pod, or for all Pods behind a Deployment. Provide exactly one of podName or deploymentName. For a crashing/restarting container (CrashLoopBackOff, restartCount > 0), set previous:true to see the log from BEFORE the crash — the current container\'s logs alone usually only show the fresh, healthy startup.',
    input_schema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'A specific Pod name.' },
        deploymentName: { type: 'string', description: "A Deployment name — logs are fetched from up to 3 of its Pods." },
        namespace: { type: 'string', description: 'Namespace.' },
        container: { type: 'string', description: 'Container name, if the Pod has more than one.' },
        tailLines: { type: 'number', description: 'Number of lines to fetch from the end of the log (default 200, max 1000).' },
        previous: { type: 'boolean', description: "Fetch the previous (pre-crash/pre-restart) container instance's log instead of the current one." },
      },
      required: ['namespace'],
    },
  },
  {
    name: 'get_pod_metrics',
    description:
      "Current CPU/memory usage for a Pod, per container, from the cluster's metrics-server (kubectl top pod equivalent). Use this alongside get_resource/describe_resource (which show requests/limits, not usage) whenever the user asks about CPU throttling, OOM risk, or right-sizing — compare actual usage to the configured request/limit rather than guessing.",
    input_schema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Pod name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['podName', 'namespace'],
    },
  },
  {
    name: 'get_node_metrics',
    description:
      "Current CPU/memory usage per node (kubectl top nodes equivalent), from the cluster's metrics-server. Omit nodeName to list every node. Use this to tell node-level pressure (many pods competing for the same node's capacity, node under memory pressure causing evictions) apart from a single pod's own request/limit being too small — get_pod_metrics alone can't distinguish these.",
    input_schema: {
      type: 'object',
      properties: {
        nodeName: { type: 'string', description: 'A specific node name. Omit to list metrics for all nodes.' },
      },
    },
  },
  {
    name: 'get_deployment_history',
    description:
      "A Deployment's rollout revision history (kubectl rollout history equivalent) — each revision's ReplicaSet name, when it was created, and its container image(s). Use this before proposing rollback_deployment so both you and the user know which revision (and image) you'd actually be reverting to, and to check whether a recent image change lines up with when a problem started.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'get_events',
    description: 'Recent Kubernetes Events, optionally filtered to one resource Kind/name and/or namespace.',
    input_schema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to scope to. Omit for cluster-wide.' },
        kind: { type: 'string', description: 'Filter to events involving this Kind (capitalized, e.g. "Deployment", "Pod").' },
        name: { type: 'string', description: 'Filter to events involving this resource name.' },
        limit: { type: 'number', description: 'Max events to return (default 20, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'helm_list_releases',
    description: 'List installed Helm releases, optionally scoped to a namespace.',
    input_schema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to scope to. Omit to list across all namespaces.' },
      },
      required: [],
    },
  },
  {
    name: 'helm_get_release_values',
    description: "Fetch a Helm release's current values (YAML).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'helm_get_release_manifest',
    description: "Fetch a Helm release's current rendered manifest (YAML).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'helm_get_release_history',
    description: "A Helm release's revision history (chart/app versions, status, description per revision).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'helm_search_charts',
    description: 'Search charts available across the configured Helm repositories.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_k8s_docs',
    description:
      "Semantic search over official Kubernetes documentation (kubernetes.io) — use this when a question is about how Kubernetes itself behaves in general (e.g. what a status condition or restart policy actually means, why the CFS quota mechanism throttles CPU) rather than about this specific cluster's live state. Cite the returned url when you use a result. Returns nothing useful if the knowledge base hasn't been set up — treat an empty/error result as 'unavailable', not as 'the docs don't cover this'.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language question or topic, e.g. "why does a pod stay in ContainerCreating".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'investigate_resources',
    description:
      'Investigate several resources concurrently — each gets its own focused sub-agent that gathers evidence (logs, events, describe, metrics) and returns a verdict — instead of you looping get_logs/describe_resource yourself one at a time. Use this whenever a question spans multiple resources (e.g. "check every pod in namespace X that is not Running", "why are these 3 services unhealthy"). Investigates at most 4 resources per call; call it again for more.',
    input_schema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'Up to 4 resources to investigate in parallel.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'Resource type, plural form (e.g. "pods", "deployments", "services").' },
              name: { type: 'string', description: 'Resource name.' },
              namespace: { type: 'string', description: 'Namespace.' },
            },
            required: ['kind', 'name'],
          },
        },
        question: { type: 'string', description: 'Optional shared focus for every sub-investigation, e.g. "why is this crashing".' },
      },
      required: ['targets'],
    },
  },
];

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'scale_deployment',
    description: "Propose changing a Deployment's replica count. Requires the user's explicit approval before it runs.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment name.' },
        namespace: { type: 'string', description: 'Namespace.' },
        replicas: { type: 'number', description: 'Target replica count.' },
      },
      required: ['name', 'namespace', 'replicas'],
    },
  },
  {
    name: 'restart_deployment',
    description:
      "Propose a rollout restart of a Deployment (bumps its pod template's restartedAt annotation). Requires the user's explicit approval before it runs.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'rollback_deployment',
    description:
      "Propose rolling back a Deployment to an earlier ReplicaSet revision (kubectl rollout undo equivalent — call get_deployment_history first to see available revisions). Requires the user's explicit approval before it runs; they will see a before/after container image diff.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment name.' },
        namespace: { type: 'string', description: 'Namespace.' },
        revision: { type: 'number', description: 'Revision number to roll back to (see get_deployment_history). Omit to roll back to the immediately previous revision.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'apply_manifest',
    description:
      'Propose creating or updating (kubectl-apply-equivalent) a resource from a full manifest. Requires the user\'s explicit approval before it runs; they will see a before/after diff.',
    input_schema: {
      type: 'object',
      properties: {
        manifest: {
          type: 'object',
          description: 'A complete Kubernetes object: apiVersion, kind, metadata.name (and metadata.namespace for namespaced kinds), spec, etc.',
        },
      },
      required: ['manifest'],
    },
  },
  {
    name: 'delete_resource',
    description: "Propose deleting a resource. Requires the user's explicit approval before it runs.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Resource type, plural form (e.g. "pods", "deployments").' },
        name: { type: 'string', description: 'Resource name.' },
        namespace: { type: 'string', description: 'Namespace (required for namespaced kinds).' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'helm_install',
    description:
      "Propose installing a Helm chart as a new release. Requires the user's explicit approval before it runs; they will see the rendered manifest it would create.",
    input_schema: {
      type: 'object',
      properties: {
        chart: { type: 'string', description: 'Chart reference, e.g. "bitnami/redis".' },
        releaseName: { type: 'string', description: 'Name for the new release.' },
        namespace: { type: 'string', description: 'Namespace to install into.' },
        version: { type: 'string', description: 'Chart version. Omit for the latest.' },
        values: { type: 'string', description: 'Values override (YAML). Omit to use the chart defaults.' },
      },
      required: ['chart', 'releaseName', 'namespace'],
    },
  },
  {
    name: 'helm_upgrade',
    description:
      "Propose upgrading an existing Helm release's chart version and/or values. Requires the user's explicit approval before it runs; they will see a before/after manifest diff.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
        version: { type: 'string', description: 'Target chart version. Omit to keep the current version.' },
        values: { type: 'string', description: 'New values override (YAML). Omit to keep the current values.' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'helm_rollback',
    description: "Propose rolling back a Helm release to an earlier revision. Requires the user's explicit approval before it runs.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
        revision: { type: 'number', description: 'Revision number to roll back to (see helm_get_release_history).' },
      },
      required: ['name', 'namespace', 'revision'],
    },
  },
  {
    name: 'helm_uninstall',
    description: "Propose uninstalling a Helm release. Requires the user's explicit approval before it runs.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Release name.' },
        namespace: { type: 'string', description: 'Namespace.' },
      },
      required: ['name', 'namespace'],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

/** investigate_resources fans out into several relay calls of its own (see
 * services/investigationAgent.ts) — ws/streams.ts needs to recognize it and route it there
 * instead of through the plain executeReadTool switch, which has no relay/streaming access. */
export function isInvestigationTool(name: string): boolean {
  return name === 'investigate_resources';
}

// Destructive tools that need the `delete` capability specifically, not just `write` — the
// rest of WRITE_TOOLS only needs `write`. Mirrors delete_resource's own tier: a `rwonly` role
// has `write` but not `delete`.
const DELETE_TIER_TOOL_NAMES = new Set(['delete_resource', 'rollback_deployment', 'helm_rollback', 'helm_uninstall']);

/** Used both to filter the catalog above and to re-check a write tool's required capability at
 * action_decision time (ws/streams.ts) — a long-lived socket can outlive a role change. */
export function requiresDeleteCapability(name: string): boolean {
  return DELETE_TIER_TOOL_NAMES.has(name);
}

/** The tool catalog offered to Claude for one connection — filtered by the session's own RBAC
 * role so a viewer/read-only session's model never even sees a mutating tool as callable, let
 * alone gets to the approval step. */
export function toolCatalogForRole(role: Role | undefined | null): ToolDefinition[] {
  const tools = [...READ_TOOLS];
  if (hasCapability(role, 'write')) {
    tools.push(...WRITE_TOOLS.filter((t) => !DELETE_TIER_TOOL_NAMES.has(t.name)));
  }
  if (hasCapability(role, 'delete')) {
    tools.push(...WRITE_TOOLS.filter((t) => DELETE_TIER_TOOL_NAMES.has(t.name)));
  }
  return tools;
}

export function describeProposedAction(name: string, input: any): string {
  switch (name) {
    case 'scale_deployment':
      return `Scale deployment "${input?.name}" in namespace "${input?.namespace}" to ${input?.replicas} replica(s)`;
    case 'restart_deployment':
      return `Restart deployment "${input?.name}" in namespace "${input?.namespace}"`;
    case 'rollback_deployment': {
      const rev = input?.revision ? ` to revision ${input.revision}` : ' to the previous revision';
      return `Roll back deployment "${input?.name}" in namespace "${input?.namespace}"${rev}`;
    }
    case 'apply_manifest': {
      const manifest = input?.manifest ?? {};
      const ns = manifest.metadata?.namespace ? ` in namespace "${manifest.metadata.namespace}"` : '';
      return `Apply ${manifest.kind ?? 'resource'} "${manifest.metadata?.name ?? 'unknown'}"${ns}`;
    }
    case 'delete_resource': {
      const ns = input?.namespace ? ` in namespace "${input.namespace}"` : '';
      return `Delete ${input?.kind} "${input?.name}"${ns}`;
    }
    case 'helm_install':
      return `Install chart "${input?.chart}" as release "${input?.releaseName}" in namespace "${input?.namespace}"`;
    case 'helm_upgrade': {
      const version = input?.version ? ` to version ${input.version}` : '';
      return `Upgrade Helm release "${input?.name}" in namespace "${input?.namespace}"${version}`;
    }
    case 'helm_rollback':
      return `Roll back Helm release "${input?.name}" in namespace "${input?.namespace}" to revision ${input?.revision}`;
    case 'helm_uninstall':
      return `Uninstall Helm release "${input?.name}" in namespace "${input?.namespace}"`;
    default:
      return `Run ${name}`;
  }
}

/** Builds the summary + (for apply_manifest/helm_install/helm_upgrade) before/after diff shown
 * on the approval card, fetched BEFORE the user approves anything — every one of these lookups
 * is read-only (get/dry-run), safe to run eagerly. */
export async function prepareActionProposal(name: string, input: any, ctx: ToolExecCtx): Promise<ActionProposal> {
  const summary = describeProposedAction(name, input);

  if (name === 'apply_manifest') {
    const manifest = input?.manifest;
    if (!manifest || typeof manifest !== 'object') return { summary, blocked: 'The manifest could not be validated, so no apply was proposed.' };

    const after = JSON.stringify(manifest, null, 2);
    const plural = manifest.kind ? pluralForKind(String(manifest.kind)) : undefined;
    const resourceName = manifest.metadata?.name;
    if (!plural || !resourceName) {
      return { summary, blocked: 'The manifest must include a recognized kind and metadata.name before its existence can be checked.' };
    }

    try {
      const existing = await getResource(plural, String(resourceName), ctx.context, manifest.metadata?.namespace, ctx.kubeOptions);
      const before = JSON.stringify(sanitizeForEdit(redactIfSensitive(existing, plural)), null, 2);
      return {
        summary,
        blocked: `${manifest.kind} "${resourceName}" already exists${manifest.metadata?.namespace ? ` in namespace "${manifest.metadata.namespace}"` : ''}; no create/apply was proposed.`,
        diff: { before, after },
      };
    } catch (err) {
      // Only a confirmed NotFound is safe to treat as a new resource. Auth, network,
      // validation, and server errors must never fall through to an unverified proposal.
      if (err instanceof HttpError && err.status === 404) return { summary, diff: { after } };
      return { summary, blocked: `Could not verify whether ${manifest.kind} "${resourceName}" exists: ${await describeK8sError(err)}. No apply was proposed.` };
    }
  }

  if (name === 'rollback_deployment') {
    try {
      const depName = String(input?.name ?? '');
      const namespace = String(input?.namespace ?? '');
      const [current, history] = await Promise.all([
        getResource('deployments', depName, ctx.context, namespace, ctx.kubeOptions),
        workloadsService.deploymentHistory(depName, namespace, ctx.context, ctx.kubeOptions),
      ]);
      const revisions = history.revisions;
      const target = input?.revision
        ? revisions.find((r: any) => r.revision === input.revision)
        : revisions[revisions.length - 2];
      if (!target) return { summary };
      const before = JSON.stringify(
        { images: (current as any)?.spec?.template?.spec?.containers?.map((c: any) => c.image) ?? [] },
        null,
        2,
      );
      const after = JSON.stringify({ revision: target.revision, images: target.images }, null, 2);
      return { summary, diff: { before, after } };
    } catch {
      // The target revision may no longer exist (its ReplicaSet was garbage-collected), or
      // history couldn't be fetched — the approval card still shows the summary; the real
      // error (e.g. "No previous revision") surfaces once the tool actually runs.
      return { summary };
    }
  }

  if (name === 'helm_install') {
    if (!ctx.helm) return { summary, blocked: HELM_ACCESS_UNAVAILABLE };
    const releaseName = String(input?.releaseName ?? '');
    const namespace = String(input?.namespace ?? '');
    if (!releaseName || !namespace) return { summary, blocked: 'Release name and namespace are required to check for an existing Helm release.' };
    try {
      const releases = await helmService.listReleases(ctx.helm.session, ctx.helm.scoped, namespace);
      if (releases.some((release) => release?.name === releaseName && release?.namespace === namespace)) {
        return { summary, blocked: `Helm release "${releaseName}" already exists in namespace "${namespace}"; no install was proposed. Use helm_upgrade if you intend to change it.` };
      }
      const after = await helmService.previewInstall(ctx.helm.session, ctx.helm.scoped, {
        chart: String(input?.chart ?? ''),
        releaseName,
        namespace,
        version: input?.version ? String(input.version) : undefined,
        values: input?.values ? String(input.values) : undefined,
      });
      return { summary, diff: { after } };
    } catch (err) {
      return { summary, blocked: `Could not verify or preview Helm release "${releaseName}" in namespace "${namespace}": ${await describeK8sError(err)}. No install was proposed.` };
    }
  }

  if (name === 'helm_upgrade' && ctx.helm) {
    try {
      const releaseName = String(input?.name ?? '');
      const namespace = String(input?.namespace ?? '');
      const params = {
        version: input?.version ? String(input.version) : undefined,
        values: input?.values ? String(input.values) : undefined,
      };
      const [before, after] = await Promise.all([
        helmService.getReleaseManifest(ctx.helm.session, ctx.helm.scoped, releaseName, namespace),
        helmService.previewUpgrade(ctx.helm.session, ctx.helm.scoped, releaseName, namespace, params),
      ]);
      return { summary, diff: { before, after } };
    } catch {
      return { summary };
    }
  }

  return { summary };
}

export async function executeReadTool(name: string, input: any, ctx: ToolExecCtx): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_resources': {
        const kind = input?.kind;
        if (!kind) throw badRequest('kind is required');
        const namespace = input?.namespace ? String(input.namespace) : undefined;
        const items = await listResource(String(kind), ctx.context, namespace, ctx.kubeOptions);
        const shaped = input?.full
          ? items.map((item: any) => stripReadNoise(redactIfSensitive(item, String(kind))))
          : items.map((item: any) => summarizeForList(item, String(kind)));
        return okList(shaped);
      }
      case 'get_resource': {
        const { kind, name: resourceName, namespace } = input ?? {};
        if (!kind || !resourceName) throw badRequest('kind and name are required');
        const resource = await getResource(
          String(kind),
          String(resourceName),
          ctx.context,
          namespace ? String(namespace) : undefined,
          ctx.kubeOptions,
        );
        // Secret/ConfigMap values never enter a tool result — this content is rendered in
        // chat and re-sent to the LLM on every later turn (see redactIfSensitive's doc comment).
        return ok(JSON.stringify(stripReadNoise(redactIfSensitive(resource, String(kind))), null, 2));
      }
      case 'describe_resource': {
        const { kind, name: resourceName, namespace } = input ?? {};
        if (!kind || !resourceName || !namespace) throw badRequest('kind, name, and namespace are required');
        const detail = await buildResourceDetail(String(kind), String(namespace), String(resourceName), ctx.context, ctx.kubeOptions);
        return ok(JSON.stringify(detail, null, 2));
      }
      case 'get_logs': {
        const { podName, deploymentName, namespace, container, previous } = input ?? {};
        if (!namespace) throw badRequest('namespace is required');
        if (!podName && !deploymentName) throw badRequest('podName or deploymentName is required');
        const tailLines = clampTailLines(input?.tailLines);
        const logOpts = { tailLines, context: ctx.context, kubeOptions: ctx.kubeOptions, previous: !!previous };
        const result = podName
          ? await fetchPodLogsOnce(String(namespace), String(podName), container ? String(container) : undefined, logOpts)
          : await fetchDeploymentLogsOnce(String(namespace), String(deploymentName), container ? String(container) : undefined, logOpts);
        return ok(result.text + (result.truncated ? '\n… (truncated)' : ''));
      }
      case 'get_pod_metrics': {
        const { podName, namespace } = input ?? {};
        if (!podName || !namespace) throw badRequest('podName and namespace are required');
        // ctx.kubeOptions.kubeconfigPath is always populated here (resolveSessionKubeAccess
        // always sets it) — just typed loosely as optional for callers that don't have a
        // session yet, so resourcesService's stricter KubeOptions needs it asserted.
        const snapshot = await resourcesService.getPodMetrics(String(podName), String(namespace), ctx.context, {
          kubeconfigPath: ctx.kubeOptions.kubeconfigPath!,
          fallbackContext: ctx.kubeOptions.fallbackContext ?? null,
          azureConfigDir: ctx.kubeOptions.azureConfigDir,
        });
        return ok(JSON.stringify(snapshot, null, 2));
      }
      case 'get_node_metrics': {
        const nodeName = input?.nodeName ? String(input.nodeName) : undefined;
        const snapshots = await resourcesService.getNodeMetrics(nodeName, ctx.context, {
          kubeconfigPath: ctx.kubeOptions.kubeconfigPath!,
          fallbackContext: ctx.kubeOptions.fallbackContext ?? null,
          azureConfigDir: ctx.kubeOptions.azureConfigDir,
        });
        return okList(snapshots);
      }
      case 'get_deployment_history': {
        const { name: depName, namespace } = input ?? {};
        if (!depName || !namespace) throw badRequest('name and namespace are required');
        const history = await workloadsService.deploymentHistory(String(depName), String(namespace), ctx.context, ctx.kubeOptions);
        return okList(history.revisions);
      }
      case 'get_events': {
        const { namespace, kind, name: resourceName } = input ?? {};
        const filter = kind || resourceName ? { kind: kind ? String(kind) : undefined, name: resourceName ? String(resourceName) : undefined } : undefined;
        const events = await filterAndSortEvents(
          ctx.context,
          namespace ? String(namespace) : undefined,
          ctx.kubeOptions,
          filter,
          clampLimit(input?.limit),
        );
        return okList(events ?? []);
      }
      case 'helm_list_releases': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const namespace = input?.namespace ? String(input.namespace) : undefined;
        const releases = await helmService.listReleases(ctx.helm.session, ctx.helm.scoped, namespace);
        return okList(releases);
      }
      case 'helm_get_release_values': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        const values = await helmService.getReleaseValues(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace));
        return ok(values);
      }
      case 'helm_get_release_manifest': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        const manifest = await helmService.getReleaseManifest(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace));
        return ok(manifest);
      }
      case 'helm_get_release_history': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        const history = await helmService.getReleaseHistory(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace));
        return okList(history);
      }
      case 'helm_search_charts': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const charts = await helmService.searchCharts(ctx.helm.session, ctx.helm.scoped);
        return okList(charts);
      }
      case 'search_k8s_docs': {
        const { query } = input ?? {};
        if (!query) throw badRequest('query is required');
        const results = await aiService.searchDocs(String(query));
        return okList(results);
      }
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return fail(err);
  }
}

/** Validates a write against the cluster without persisting it. Auto mode always calls this
 * immediately before executeWriteTool; any preview failure therefore prevents the mutation. */
export async function dryRunWriteTool(name: string, input: any, ctx: ToolExecCtx): Promise<ToolResult> {
  try {
    switch (name) {
      case 'scale_deployment': {
        const { name: depName, namespace, replicas } = input ?? {};
        if (!depName || !namespace || typeof replicas !== 'number') throw badRequest('name, namespace, and replicas are required');
        await workloadsService.scaleDeployment(String(depName), String(namespace), ctx.context, replicas, ctx.kubeOptions, true);
        break;
      }
      case 'restart_deployment': {
        const { name: depName, namespace } = input ?? {};
        if (!depName || !namespace) throw badRequest('name and namespace are required');
        await workloadsService.restartDeployment(String(depName), String(namespace), ctx.context, ctx.kubeOptions, true);
        break;
      }
      case 'rollback_deployment': {
        const { name: depName, namespace, revision } = input ?? {};
        if (!depName || !namespace) throw badRequest('name and namespace are required');
        await workloadsService.rollbackDeployment(
          String(depName), String(namespace), ctx.context,
          typeof revision === 'number' ? revision : undefined, ctx.kubeOptions, true,
        );
        break;
      }
      case 'apply_manifest': {
        const manifest = input?.manifest;
        if (!manifest || typeof manifest !== 'object') throw badRequest('manifest is required');
        await applyManifest(manifest, ctx.context, ctx.kubeOptions, true);
        break;
      }
      case 'delete_resource': {
        const { kind, name: resourceName, namespace } = input ?? {};
        if (!kind || !resourceName) throw badRequest('kind and name are required');
        await deleteResource(String(kind), String(resourceName), ctx.context, namespace ? String(namespace) : undefined, ctx.kubeOptions, true);
        break;
      }
      case 'helm_install': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { chart, releaseName, namespace, version, values } = input ?? {};
        if (!chart || !releaseName || !namespace) throw badRequest('chart, releaseName, and namespace are required');
        await helmService.installRelease(ctx.helm.session, ctx.helm.scoped, {
          chart: String(chart), releaseName: String(releaseName), namespace: String(namespace),
          version: version ? String(version) : undefined, values: values ? String(values) : undefined,
        }, { dryRun: true });
        break;
      }
      case 'helm_upgrade': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace, version, values } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        await helmService.previewUpgrade(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace), {
          version: version ? String(version) : undefined, values: values ? String(values) : undefined,
        });
        break;
      }
      case 'helm_rollback': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace, revision } = input ?? {};
        if (!releaseName || !namespace || typeof revision !== 'number') throw badRequest('name, namespace, and revision are required');
        await helmService.previewRollbackRelease(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace), revision);
        break;
      }
      case 'helm_uninstall': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        await helmService.previewUninstallRelease(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace));
        break;
      }
      default:
        return { output: `No dry-run is available for ${name}; no changes were made.`, isError: true };
    }
    return ok(`Dry-run succeeded for ${name}.`);
  } catch (err) {
    return fail(err);
  }
}

/** Only ever called from the approval-decision path (see ws/streams.ts), never from the
 * auto-executing read-tool loop. */
export async function executeWriteTool(name: string, input: any, ctx: ToolExecCtx): Promise<ToolResult> {
  try {
    switch (name) {
      case 'scale_deployment': {
        const { name: depName, namespace, replicas } = input ?? {};
        if (!depName || !namespace || typeof replicas !== 'number') {
          throw badRequest('name, namespace, and replicas are required');
        }
        await workloadsService.scaleDeployment(String(depName), String(namespace), ctx.context, replicas, ctx.kubeOptions);
        return ok(`Scaled deployment "${depName}" in namespace "${namespace}" to ${replicas} replica(s).`);
      }
      case 'restart_deployment': {
        const { name: depName, namespace } = input ?? {};
        if (!depName || !namespace) throw badRequest('name and namespace are required');
        await workloadsService.restartDeployment(String(depName), String(namespace), ctx.context, ctx.kubeOptions);
        return ok(`Restarted deployment "${depName}" in namespace "${namespace}".`);
      }
      case 'rollback_deployment': {
        const { name: depName, namespace, revision } = input ?? {};
        if (!depName || !namespace) throw badRequest('name and namespace are required');
        const result = await workloadsService.rollbackDeployment(
          String(depName),
          String(namespace),
          ctx.context,
          typeof revision === 'number' ? revision : undefined,
          ctx.kubeOptions,
        );
        return ok(`Rolled back deployment "${depName}" in namespace "${namespace}" to revision ${result.rolledBackTo}.`);
      }
      case 'apply_manifest': {
        const manifest = input?.manifest;
        if (!manifest || typeof manifest !== 'object') throw badRequest('manifest is required');
        const { object, created } = await applyManifest(manifest, ctx.context, ctx.kubeOptions);
        const plural = manifest.kind ? pluralForKind(String(manifest.kind)) : undefined;
        const redacted = plural ? redactIfSensitive(object, plural) : object;
        return ok(`${created ? 'Created' : 'Updated'} ${manifest.kind} "${manifest.metadata?.name}".\n\n${JSON.stringify(redacted, null, 2)}`);
      }
      case 'delete_resource': {
        const { kind, name: resourceName, namespace } = input ?? {};
        if (!kind || !resourceName) throw badRequest('kind and name are required');
        await deleteResource(String(kind), String(resourceName), ctx.context, namespace ? String(namespace) : undefined, ctx.kubeOptions);
        return ok(`Deleted ${kind} "${resourceName}"${namespace ? ` in namespace "${namespace}"` : ''}.`);
      }
      case 'helm_install': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { chart, releaseName, namespace, version, values } = input ?? {};
        if (!chart || !releaseName || !namespace) throw badRequest('chart, releaseName, and namespace are required');
        const output = await helmService.installRelease(ctx.helm.session, ctx.helm.scoped, {
          chart: String(chart),
          releaseName: String(releaseName),
          namespace: String(namespace),
          version: version ? String(version) : undefined,
          values: values ? String(values) : undefined,
        });
        return ok(`Installed release "${releaseName}" in namespace "${namespace}".\n\n${output}`);
      }
      case 'helm_upgrade': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace, version, values } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        const output = await helmService.upgradeRelease(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace), {
          version: version ? String(version) : undefined,
          values: values ? String(values) : undefined,
        });
        return ok(`Upgraded release "${releaseName}" in namespace "${namespace}".\n\n${output}`);
      }
      case 'helm_rollback': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace, revision } = input ?? {};
        if (!releaseName || !namespace || typeof revision !== 'number') throw badRequest('name, namespace, and revision are required');
        const output = await helmService.rollbackRelease(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace), revision);
        return ok(`Rolled back release "${releaseName}" in namespace "${namespace}" to revision ${revision}.\n\n${output}`);
      }
      case 'helm_uninstall': {
        if (!ctx.helm) return { output: HELM_ACCESS_UNAVAILABLE, isError: true };
        const { name: releaseName, namespace } = input ?? {};
        if (!releaseName || !namespace) throw badRequest('name and namespace are required');
        const output = await helmService.uninstallRelease(ctx.helm.session, ctx.helm.scoped, String(releaseName), String(namespace));
        return ok(`Uninstalled release "${releaseName}" in namespace "${namespace}".\n\n${output}`);
      }
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return fail(err);
  }
}
