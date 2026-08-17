import type { ChangeRecord } from './types.js';
import type { ResourceKind } from '../kube/resources.js';
import { RESOURCE_KINDS } from '../kube/resources.js';

export interface WatchedKind {
  id: 'pods' | 'deployments' | 'replicasets' | 'statefulsets';
  resourceKind: ResourceKind;
  extractChanges(prev: any | undefined, next: any): ChangeRecord[];
}

function extractPodChanges(prev: any | undefined, next: any): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  const ts = new Date();
  const ns = next.metadata?.namespace;
  const name = next.metadata?.name;
  const uid = next.metadata?.uid;

  if (!prev) {
    records.push({
      kind: 'Pod',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'created',
      severity: 'info',
      summary: `Pod ${name} created in ${ns}`,
    });
    return records;
  }

  const prevPhase = prev.status?.phase;
  const nextPhase = next.status?.phase;
  if (prevPhase !== nextPhase) {
    records.push({
      kind: 'Pod',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'phase',
      severity: nextPhase === 'Failed' ? 'error' : nextPhase === 'Pending' ? 'info' : 'warning',
      summary: `Pod ${name} phase changed from ${prevPhase} to ${nextPhase}`,
      before: { phase: prevPhase },
      after: { phase: nextPhase },
    });
  }

  const prevConditionsHash = hashConditions(prev.status?.conditions);
  const nextConditionsHash = hashConditions(next.status?.conditions);
  if (prevConditionsHash !== nextConditionsHash) {
    const nextReady = (next.status?.conditions || []).find((c: any) => c.type === 'Ready');
    records.push({
      kind: 'Pod',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'condition',
      severity: nextReady?.status === 'False' ? 'warning' : 'info',
      summary: `Pod ${name} conditions changed`,
    });
  }

  const prevRestarts = countRestarts(prev.status?.containerStatuses);
  const nextRestarts = countRestarts(next.status?.containerStatuses);
  if (prevRestarts !== nextRestarts) {
    records.push({
      kind: 'Pod',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'restartCount',
      severity: 'warning',
      summary: `Pod ${name} restart count increased (${prevRestarts} → ${nextRestarts})`,
      before: { restartCount: prevRestarts },
      after: { restartCount: nextRestarts },
    });
  }

  const prevImages = extractImages(prev.status?.containerStatuses);
  const nextImages = extractImages(next.status?.containerStatuses);
  if (JSON.stringify(prevImages) !== JSON.stringify(nextImages)) {
    records.push({
      kind: 'Pod',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'image',
      severity: 'info',
      summary: `Pod ${name} image updated`,
      before: { images: prevImages },
      after: { images: nextImages },
    });
  }

  return records;
}

function extractDeploymentChanges(prev: any | undefined, next: any): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  const ts = new Date();
  const ns = next.metadata?.namespace;
  const name = next.metadata?.name;
  const uid = next.metadata?.uid;

  if (!prev) {
    records.push({
      kind: 'Deployment',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'created',
      severity: 'info',
      summary: `Deployment ${name} created in ${ns}`,
    });
    return records;
  }

  const prevGeneration = prev.metadata?.generation;
  const nextGeneration = next.metadata?.generation;
  if (prevGeneration !== nextGeneration) {
    records.push({
      kind: 'Deployment',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'image',
      severity: 'info',
      summary: `Deployment ${name} spec updated`,
    });
  }

  const prevReplicas = prev.status?.replicas;
  const nextReplicas = next.status?.replicas;
  if (prevReplicas !== nextReplicas) {
    records.push({
      kind: 'Deployment',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'condition',
      severity: 'info',
      summary: `Deployment ${name} replicas: ${prevReplicas} → ${nextReplicas}`,
      before: { replicas: prevReplicas },
      after: { replicas: nextReplicas },
    });
  }

  return records;
}

function extractReplicaSetChanges(prev: any | undefined, next: any): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  const ts = new Date();
  const ns = next.metadata?.namespace;
  const name = next.metadata?.name;
  const uid = next.metadata?.uid;

  if (!prev) {
    records.push({
      kind: 'ReplicaSet',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'created',
      severity: 'info',
      summary: `ReplicaSet ${name} created in ${ns}`,
    });
    return records;
  }

  const prevReplicas = prev.status?.replicas;
  const nextReplicas = next.status?.replicas;
  if (prevReplicas !== nextReplicas) {
    records.push({
      kind: 'ReplicaSet',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'condition',
      severity: 'info',
      summary: `ReplicaSet ${name} replicas: ${prevReplicas} → ${nextReplicas}`,
      before: { replicas: prevReplicas },
      after: { replicas: nextReplicas },
    });
  }

  return records;
}

function extractStatefulSetChanges(prev: any | undefined, next: any): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  const ts = new Date();
  const ns = next.metadata?.namespace;
  const name = next.metadata?.name;
  const uid = next.metadata?.uid;

  if (!prev) {
    records.push({
      kind: 'StatefulSet',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'created',
      severity: 'info',
      summary: `StatefulSet ${name} created in ${ns}`,
    });
    return records;
  }

  const prevGeneration = prev.metadata?.generation;
  const nextGeneration = next.metadata?.generation;
  if (prevGeneration !== nextGeneration) {
    records.push({
      kind: 'StatefulSet',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'image',
      severity: 'info',
      summary: `StatefulSet ${name} spec updated`,
    });
  }

  const prevReplicas = prev.status?.replicas;
  const nextReplicas = next.status?.replicas;
  if (prevReplicas !== nextReplicas) {
    records.push({
      kind: 'StatefulSet',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'workloadChange',
      changeType: 'condition',
      severity: 'info',
      summary: `StatefulSet ${name} replicas: ${prevReplicas} → ${nextReplicas}`,
      before: { replicas: prevReplicas },
      after: { replicas: nextReplicas },
    });
  }

  return records;
}

function extractEventChanges(_prev: any | undefined, next: any): ChangeRecord[] {
  const ts = new Date(next.lastTimestamp || next.firstTimestamp || Date.now());
  const ns = next.metadata?.namespace;
  const name = next.metadata?.name;
  const uid = next.metadata?.uid;
  const eventType = (next.type || 'Normal').toLowerCase();
  const severity = eventType === 'warning' ? 'warning' : eventType === 'error' ? 'error' : 'info';
  const changeType = eventType === 'warning' ? 'warningEvent' : 'normalEvent';

  return [
    {
      kind: 'Event',
      namespace: ns,
      name,
      uid,
      ts,
      category: 'k8sEvent',
      changeType,
      severity,
      summary: next.reason ? `${next.reason}: ${next.message}` : next.message || 'Event',
      reason: next.reason,
      involvedObject: next.involvedObject ? {
        kind: next.involvedObject.kind,
        name: next.involvedObject.name,
        namespace: next.involvedObject.namespace,
      } : undefined,
    },
  ];
}

function hashConditions(conditions: any[] | undefined): string {
  if (!conditions) return '';
  return JSON.stringify(
    (conditions || [])
      .map((c: any) => ({ type: c.type, status: c.status }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  );
}

function countRestarts(containerStatuses: any[] | undefined): number {
  if (!containerStatuses) return 0;
  return (containerStatuses || []).reduce((sum, cs: any) => sum + (cs.restartCount || 0), 0);
}

function extractImages(containerStatuses: any[] | undefined): string[] {
  if (!containerStatuses) return [];
  return (containerStatuses || []).map((cs: any) => cs.image).filter(Boolean);
}

export const WATCHED_KINDS: WatchedKind[] = [
  { id: 'pods', resourceKind: RESOURCE_KINDS.pods, extractChanges: extractPodChanges },
  { id: 'deployments', resourceKind: RESOURCE_KINDS.deployments, extractChanges: extractDeploymentChanges },
  { id: 'replicasets', resourceKind: RESOURCE_KINDS.replicasets, extractChanges: extractReplicaSetChanges },
  { id: 'statefulsets', resourceKind: RESOURCE_KINDS.statefulsets, extractChanges: extractStatefulSetChanges },
];

export const EVENT_KIND: WatchedKind = {
  id: 'pods', // dummy id, not used in loop
  resourceKind: RESOURCE_KINDS.events,
  extractChanges: extractEventChanges,
};
