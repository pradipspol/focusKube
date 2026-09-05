import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as dagre from 'dagre';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { ApplicationSelector, type ApplicationOption } from './ApplicationSelector';
import { uiText } from '../text';
import { LoadingOverlay } from './LoadingOverlay';

interface Props {
  scope: Scope;
  namespaces: string[];
}

// Kinds fetched for the whole namespace up front. Owner-chain kinds come first,
// then everything else the graph can connect to.
const TOP_LEVEL_PLURALS = ['deployments', 'statefulsets', 'daemonsets'] as const;
const OWNED_PLURALS = ['replicasets', 'pods'] as const;
const RELATED_PLURALS = ['services', 'ingresses', 'networkpolicies', 'configmaps', 'secrets'] as const;
const ALL_PLURALS = [...TOP_LEVEL_PLURALS, ...OWNED_PLURALS, ...RELATED_PLURALS] as const;
type GraphPlural = (typeof ALL_PLURALS)[number];

const KIND_BY_PLURAL: Record<GraphPlural, string> = {
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet',
  pods: 'Pod',
  services: 'Service',
  ingresses: 'Ingress',
  networkpolicies: 'NetworkPolicy',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
};

const NODE_COLOR: Record<string, string> = {
  HelmRelease: '#d4af37',
  Deployment: '#3b82f6',
  StatefulSet: '#06b6d4',
  DaemonSet: '#14b8a6',
  ReplicaSet: '#8b5cf6',
  Pod: '#22c55e',
  Service: '#eab308',
  Ingress: '#f97316',
  NetworkPolicy: '#ec4899',
  ConfigMap: '#64748b',
  Secret: '#a16207',
  Registry: '#78716c',
};

const NODE_WIDTH = 190;
const NODE_HEIGHT = 40;

type GraphData = Record<GraphPlural, K8sObject[]>;

function ownerRefsOf(obj: K8sObject): Array<{ kind?: string; name?: string; uid?: string }> {
  const refs = (obj.metadata as any)?.ownerReferences;
  return Array.isArray(refs) ? refs : [];
}

function labelsOf(obj: K8sObject): Record<string, string> {
  return obj.metadata?.labels ?? {};
}

function annotationsOf(obj: K8sObject): Record<string, string> {
  return obj.metadata?.annotations ?? {};
}

function nodeId(kind: string, obj: K8sObject): string {
  return obj.metadata?.uid ?? `${kind}/${obj.metadata?.namespace ?? ''}/${obj.metadata?.name ?? ''}`;
}

// An "application" groups by the standard app.kubernetes.io/instance (or legacy
// `release`) label, matching the same convention the Applications tab uses.
// Workloads without either label get their own singleton entry instead of being
// silently dropped from the filter.
function appKeyOf(kind: string, obj: K8sObject): string {
  const labels = labelsOf(obj);
  const instance = labels['app.kubernetes.io/instance'] || labels['release'];
  return instance ? `instance:${instance}` : `standalone:${kind}:${obj.metadata?.name}`;
}

function appLabelOf(obj: K8sObject): string {
  const labels = labelsOf(obj);
  return labels['app.kubernetes.io/instance'] || labels['release'] || obj.metadata?.name || '(unnamed)';
}

function helmReleaseOf(obj: K8sObject): string | undefined {
  return annotationsOf(obj)['meta.helm.sh/release-name'];
}

function selectorMatches(selector: Record<string, string> | undefined, podLabels: Record<string, string>): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([key, value]) => podLabels[key] === value);
}

// Kubernetes semantics: an empty podSelector on a NetworkPolicy means "all pods in
// the namespace", unlike a Service selector where empty means "no pods".
function networkPolicySelectorMatches(spec: any, podLabels: Record<string, string>): boolean {
  const matchLabels = spec?.podSelector?.matchLabels ?? {};
  if (Object.keys(matchLabels).length === 0) return true;
  return Object.entries(matchLabels).every(([key, value]) => (podLabels as any)[key] === value);
}

function ingressServiceNames(ingress: K8sObject): string[] {
  const names = new Set<string>();
  const spec = ingress.spec as any;
  const defaultSvc = spec?.defaultBackend?.service?.name;
  if (defaultSvc) names.add(defaultSvc);
  for (const rule of spec?.rules ?? []) {
    for (const path of rule?.http?.paths ?? []) {
      const name = path?.backend?.service?.name ?? path?.backend?.serviceName;
      if (name) names.add(name);
    }
  }
  return Array.from(names);
}

function containersOf(pod: K8sObject): any[] {
  const spec = pod.spec as any;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])];
}

function configAndSecretRefsOf(pod: K8sObject): { configMaps: Set<string>; secrets: Set<string> } {
  const configMaps = new Set<string>();
  const secrets = new Set<string>();
  for (const container of containersOf(pod)) {
    for (const ef of container.envFrom ?? []) {
      if (ef.configMapRef?.name) configMaps.add(ef.configMapRef.name);
      if (ef.secretRef?.name) secrets.add(ef.secretRef.name);
    }
    for (const env of container.env ?? []) {
      if (env.valueFrom?.configMapKeyRef?.name) configMaps.add(env.valueFrom.configMapKeyRef.name);
      if (env.valueFrom?.secretKeyRef?.name) secrets.add(env.valueFrom.secretKeyRef.name);
    }
  }
  for (const volume of (pod.spec as any)?.volumes ?? []) {
    if (volume.configMap?.name) configMaps.add(volume.configMap.name);
    if (volume.secret?.secretName) secrets.add(volume.secret.secretName);
  }
  return { configMaps, secrets };
}

function imagesOf(pod: K8sObject): string[] {
  return containersOf(pod)
    .map((c) => c.image)
    .filter((image): image is string => !!image);
}

// Same heuristic Docker itself uses: a registry host contains a dot/colon (or is
// "localhost"); otherwise it's an implicit Docker Hub reference (e.g. "nginx" or
// "myorg/myimage").
function registryHostOf(image: string): string {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) return 'docker.io';
  const candidate = image.slice(0, firstSlash);
  if (candidate.includes('.') || candidate.includes(':') || candidate === 'localhost') return candidate;
  return 'docker.io';
}

function makeNode(id: string, kind: string, label: string): Node {
  return {
    id,
    data: { label: `${kind}\n${label}` },
    position: { x: 0, y: 0 },
    style: {
      background: NODE_COLOR[kind] ?? '#555',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      width: NODE_WIDTH,
      fontSize: 12,
      whiteSpace: 'pre-line',
      textAlign: 'center',
      padding: 6,
    },
  };
}

function buildGraph(data: GraphData, selectedAppKeys: string[]): { nodes: Node[]; edges: Edge[] } {
  if (selectedAppKeys.length === 0) return { nodes: [], edges: [] };
  const selectedSet = new Set(selectedAppKeys);

  const topLevel = TOP_LEVEL_PLURALS.flatMap((plural) =>
    data[plural]
      .filter((obj) => selectedSet.has(appKeyOf(KIND_BY_PLURAL[plural], obj)))
      .map((obj) => ({ kind: KIND_BY_PLURAL[plural], obj })),
  );
  if (topLevel.length === 0) return { nodes: [], edges: [] };

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ownedUids = new Set(topLevel.map(({ obj }) => obj.metadata?.uid).filter((uid): uid is string => !!uid));

  for (const { kind, obj } of topLevel) {
    nodes.push(makeNode(nodeId(kind, obj), kind, obj.metadata?.name ?? '(unnamed)'));
  }

  // Iteratively pull in ReplicaSets/Pods owned (directly or transitively) by an
  // included top-level workload. A fixed-point loop because a Pod may need its
  // ReplicaSet included first before its own ownerReference resolves.
  const ownedCandidates = OWNED_PLURALS.flatMap((plural) =>
    data[plural].map((obj) => ({ kind: KIND_BY_PLURAL[plural], plural, obj })),
  );
  const includedOwned: typeof ownedCandidates = [];
  let remaining = ownedCandidates;
  let changed = true;
  while (changed) {
    changed = false;
    const stillRemaining: typeof remaining = [];
    for (const item of remaining) {
      const owner = ownerRefsOf(item.obj).find((ref) => ref.uid && ownedUids.has(ref.uid));
      if (owner) {
        const uid = item.obj.metadata?.uid;
        if (uid) ownedUids.add(uid);
        includedOwned.push(item);
        changed = true;
      } else {
        stillRemaining.push(item);
      }
    }
    remaining = stillRemaining;
  }

  for (const { kind, obj } of includedOwned) {
    nodes.push(makeNode(nodeId(kind, obj), kind, obj.metadata?.name ?? '(unnamed)'));
    const owner = ownerRefsOf(obj).find((ref) => ref.uid && ownedUids.has(ref.uid));
    if (owner?.uid) {
      const ownerNode = [...topLevel, ...includedOwned].find((n) => n.obj.metadata?.uid === owner.uid);
      if (ownerNode) {
        const ownerId = nodeId(ownerNode.kind, ownerNode.obj);
        const childId = nodeId(kind, obj);
        edges.push({ id: `${ownerId}->${childId}`, source: ownerId, target: childId, data: { relation: 'ownership' } });
      }
    }
  }

  const includedPods = includedOwned.filter((item) => item.plural === 'pods').map((item) => item.obj);

  // Helm release: group included top-level workloads under a synthetic release node.
  const releaseNames = new Set(topLevel.map(({ obj }) => helmReleaseOf(obj)).filter((r): r is string => !!r));
  for (const release of releaseNames) {
    const releaseId = `helm-release/${release}`;
    nodes.push(makeNode(releaseId, 'HelmRelease', release));
    for (const { kind, obj } of topLevel) {
      if (helmReleaseOf(obj) === release) {
        edges.push({
          id: `${releaseId}->${nodeId(kind, obj)}`,
          source: releaseId,
          target: nodeId(kind, obj),
          data: { relation: 'ownership' },
        });
      }
    }
  }

  // Services selecting an included Pod.
  const includedServices = data.services.filter((svc) =>
    includedPods.some((pod) => selectorMatches((svc.spec as any)?.selector, labelsOf(pod))),
  );
  for (const svc of includedServices) {
    const svcId = nodeId('Service', svc);
    nodes.push(makeNode(svcId, 'Service', svc.metadata?.name ?? '(unnamed)'));
    for (const pod of includedPods) {
      if (selectorMatches((svc.spec as any)?.selector, labelsOf(pod))) {
        edges.push({
          id: `${svcId}->${nodeId('Pod', pod)}`,
          source: svcId,
          target: nodeId('Pod', pod),
          data: { relation: 'supply' },
        });
      }
    }
  }

  // Ingresses referencing an included Service.
  const includedServiceNames = new Set(includedServices.map((svc) => svc.metadata?.name));
  const includedIngresses = data.ingresses.filter((ing) =>
    ingressServiceNames(ing).some((name) => includedServiceNames.has(name)),
  );
  for (const ing of includedIngresses) {
    const ingId = nodeId('Ingress', ing);
    nodes.push(makeNode(ingId, 'Ingress', ing.metadata?.name ?? '(unnamed)'));
    for (const svc of includedServices) {
      if (ingressServiceNames(ing).includes(svc.metadata?.name ?? '')) {
        edges.push({
          id: `${ingId}->${nodeId('Service', svc)}`,
          source: ingId,
          target: nodeId('Service', svc),
          data: { relation: 'supply' },
        });
      }
    }
  }

  // NetworkPolicies selecting an included Pod.
  const includedNetworkPolicies = data.networkpolicies.filter((np) =>
    includedPods.some((pod) => networkPolicySelectorMatches(np.spec, labelsOf(pod))),
  );
  for (const np of includedNetworkPolicies) {
    const npId = nodeId('NetworkPolicy', np);
    nodes.push(makeNode(npId, 'NetworkPolicy', np.metadata?.name ?? '(unnamed)'));
    for (const pod of includedPods) {
      if (networkPolicySelectorMatches(np.spec, labelsOf(pod))) {
        edges.push({
          id: `${npId}->${nodeId('Pod', pod)}`,
          source: npId,
          target: nodeId('Pod', pod),
          data: { relation: 'supply' },
        });
      }
    }
  }

  // ConfigMaps/Secrets referenced by an included Pod.
  const referencedConfigMaps = new Set<string>();
  const referencedSecrets = new Set<string>();
  const podConfigRefs = new Map<string, { configMaps: Set<string>; secrets: Set<string> }>();
  for (const pod of includedPods) {
    const refs = configAndSecretRefsOf(pod);
    podConfigRefs.set(nodeId('Pod', pod), refs);
    refs.configMaps.forEach((name) => referencedConfigMaps.add(name));
    refs.secrets.forEach((name) => referencedSecrets.add(name));
  }
  for (const cm of data.configmaps.filter((c) => referencedConfigMaps.has(c.metadata?.name ?? ''))) {
    const cmId = nodeId('ConfigMap', cm);
    nodes.push(makeNode(cmId, 'ConfigMap', cm.metadata?.name ?? '(unnamed)'));
    for (const pod of includedPods) {
      if (podConfigRefs.get(nodeId('Pod', pod))?.configMaps.has(cm.metadata?.name ?? '')) {
        edges.push({
          id: `${cmId}->${nodeId('Pod', pod)}`,
          source: cmId,
          target: nodeId('Pod', pod),
          data: { relation: 'supply' },
        });
      }
    }
  }
  for (const secret of data.secrets.filter((s) => referencedSecrets.has(s.metadata?.name ?? ''))) {
    const secretId = nodeId('Secret', secret);
    nodes.push(makeNode(secretId, 'Secret', secret.metadata?.name ?? '(unnamed)'));
    for (const pod of includedPods) {
      if (podConfigRefs.get(nodeId('Pod', pod))?.secrets.has(secret.metadata?.name ?? '')) {
        edges.push({
          id: `${secretId}->${nodeId('Pod', pod)}`,
          source: secretId,
          target: nodeId('Pod', pod),
          data: { relation: 'supply' },
        });
      }
    }
  }

  // Container registries supplying images to an included Pod.
  const registryToPods = new Map<string, Set<string>>();
  for (const pod of includedPods) {
    for (const image of imagesOf(pod)) {
      const host = registryHostOf(image);
      if (!registryToPods.has(host)) registryToPods.set(host, new Set());
      registryToPods.get(host)!.add(nodeId('Pod', pod));
    }
  }
  for (const [host, podIds] of registryToPods) {
    const registryId = `registry/${host}`;
    nodes.push(makeNode(registryId, 'Registry', host));
    for (const podId of podIds) {
      edges.push({ id: `${registryId}->${podId}`, source: registryId, target: podId, data: { relation: 'supply' } });
    }
  }

  return { nodes, edges };
}

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 64 });
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  return nodes.map((node) => {
    const { x, y } = g.node(node.id);
    return { ...node, position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 } };
  });
}

// `fitView` on <ReactFlow> only runs once, at mount — it doesn't refit when
// `nodes` changes later (a different app/namespace selection reusing the same
// mounted instance), which left large graphs positioned outside the viewport.
// Re-fitting imperatively after each real data change keeps the view honest.
function FitViewOnDataChange({ nodes }: { nodes: Node[] }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodes.length === 0) return;
    const raf = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
    return () => cancelAnimationFrame(raf);
  }, [nodes, fitView]);
  return null;
}

export function TopologyPanel({ scope, namespaces }: Props) {
  const [namespace, setNamespace] = useState('');
  const [selectedApps, setSelectedApps] = useState<string[]>([]);

  useEffect(() => {
    setSelectedApps([]);
  }, [namespace]);

  const namespaceScope = { ...scope, namespace };
  const query = useQuery({
    queryKey: ['topology', scope.context, scope.source, namespace],
    queryFn: async () => {
      const settled = await Promise.allSettled(
        ALL_PLURALS.map((plural) => api.listResource(plural, namespaceScope).then((r) => r.items)),
      );
      const data = {} as GraphData;
      const failedKinds: string[] = [];
      settled.forEach((result, i) => {
        const plural = ALL_PLURALS[i];
        if (result.status === 'fulfilled') {
          data[plural] = result.value;
        } else {
          data[plural] = [];
          failedKinds.push(KIND_BY_PLURAL[plural]);
        }
      });
      return { data, failedKinds };
    },
    enabled: !!scope.context && !!namespace,
  });

  const applications = useMemo<ApplicationOption[]>(() => {
    if (!query.data) return [];
    const seen = new Map<string, string>();
    for (const plural of TOP_LEVEL_PLURALS) {
      for (const obj of query.data.data[plural]) {
        const key = appKeyOf(KIND_BY_PLURAL[plural], obj);
        if (!seen.has(key)) seen.set(key, appLabelOf(obj));
      }
    }
    return Array.from(seen, ([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [query.data]);

  const { nodes, edges } = useMemo(() => {
    if (!query.data) return { nodes: [], edges: [] };
    const { nodes: rawNodes, edges } = buildGraph(query.data.data, selectedApps);
    return { nodes: layoutGraph(rawNodes, edges), edges };
  }, [query.data, selectedApps]);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // Reset on every graph rebuild so a stale id (from before a namespace/app change)
  // never causes every real node to render as dimmed.
  useEffect(() => setHoveredNodeId(null), [nodes]);

  // Two separate adjacency maps: "ownership" (HelmRelease->Workload->ReplicaSet->Pod)
  // stays within a single application, so traversing it fully (ancestors AND
  // descendants) is always safe. "supply" (ConfigMap/Secret/Service/Registry/
  // NetworkPolicy/Ingress) can fan out across applications that happen to share
  // infrastructure (e.g. one container registry) — those must stay a single hop,
  // or hovering one pod would light up every other app using the same registry.
  const { ownershipAdjacency, supplyAdjacency } = useMemo(() => {
    const ownershipAdjacency = new Map<string, Set<string>>();
    const supplyAdjacency = new Map<string, Set<string>>();
    const addBoth = (map: Map<string, Set<string>>, a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      if (!map.has(b)) map.set(b, new Set());
      map.get(a)!.add(b);
      map.get(b)!.add(a);
    };
    for (const edge of edges) {
      const map = edge.data?.relation === 'supply' ? supplyAdjacency : ownershipAdjacency;
      addBoth(map, edge.source, edge.target);
    }
    return { ownershipAdjacency, supplyAdjacency };
  }, [edges]);

  const connectedToHover = useMemo(() => {
    if (!hoveredNodeId) return null;
    // Full ownership tree (ancestors + descendants) — always one application.
    const visited = new Set<string>([hoveredNodeId]);
    const queue = [hoveredNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of ownershipAdjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    // Direct (one-hop only) supply neighbors of anything in that tree — e.g. a
    // pod's own ConfigMap/Service/Registry — without continuing on to whatever
    // ELSE those shared resources connect to.
    for (const node of [...visited]) {
      for (const neighbor of supplyAdjacency.get(node) ?? []) {
        visited.add(neighbor);
      }
    }
    return visited;
  }, [hoveredNodeId, ownershipAdjacency, supplyAdjacency]);

  const displayNodes = useMemo(() => {
    if (!connectedToHover) return nodes;
    return nodes.map((node) => ({
      ...node,
      style: {
        ...node.style,
        opacity: connectedToHover.has(node.id) ? 1 : 0.15,
        boxShadow: node.id === hoveredNodeId ? '0 0 0 2px #fff' : undefined,
      },
    }));
  }, [nodes, connectedToHover, hoveredNodeId]);

  const displayEdges = useMemo(() => {
    if (!connectedToHover) return edges;
    return edges.map((edge) => {
      const active = connectedToHover.has(edge.source) && connectedToHover.has(edge.target);
      return {
        ...edge,
        style: { ...edge.style, opacity: active ? 1 : 0.08, strokeWidth: active ? 2 : 1 },
        animated: active,
      };
    });
  }, [edges, connectedToHover]);

  if (!scope.context) return <div className="empty">{uiText.topology.selectContext}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="toolbar toolbar-compact-top">
        <h2 style={{ margin: 0 }}>{uiText.topology.title}</h2>
        <div className="toolbar-actions">
          {query.isFetching && <span className="tiny-spinner" aria-label={uiText.topology.loadingTopology} />}
          <select
            className="namespace-dropdown-trigger"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            <option value="">{uiText.topology.selectNamespace}</option>
            {namespaces.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {namespace && (
            <ApplicationSelector applications={applications} selected={selectedApps} onChange={setSelectedApps} />
          )}
        </div>
      </div>

      {query.data && query.data.failedKinds.length > 0 && (
        <div className="notice">
          {uiText.topology.couldNotLoadPrefix} <span className="mono">{query.data.failedKinds.join(', ')}</span> {uiText.topology.inThisNamespace}
        </div>
      )}

      {!namespace ? (
        <div className="empty">{uiText.topology.selectNamespaceToView}</div>
      ) : query.isLoading ? (
        <LoadingOverlay message={uiText.topology.loading} />
      ) : selectedApps.length === 0 ? (
        <div className="empty">{uiText.topology.selectApplicationsToView}</div>
      ) : nodes.length === 0 ? (
        <div className="empty">{uiText.topology.noObjectsFound}</div>
      ) : (
        <div style={{ flex: '1 1 auto', minHeight: 0 }}>
          <ReactFlowProvider>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
              onNodeMouseLeave={() => setHoveredNodeId(null)}
              minZoom={0.05}
            >
              <Background />
              <Controls />
              <MiniMap />
            </ReactFlow>
            <FitViewOnDataChange nodes={nodes} />
          </ReactFlowProvider>
        </div>
      )}
    </div>
  );
}
