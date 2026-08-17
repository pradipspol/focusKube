import type { K8sObject } from '../api/types';

export function age(creationTimestamp?: string): string {
  if (!creationTimestamp) return '-';
  const created = new Date(creationTimestamp).getTime();
  if (!Number.isFinite(created)) return '-';
  const diff = Math.max(0, Date.now() - created);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  const y = Math.floor(d / 365);
  const yd = d % 365;
  return yd > 0 ? `${y}y${yd}d` : `${y}y`;
}

/** Summarize a resource into a short status string + tone for the badge. */
export function statusOf(plural: string, o: K8sObject): { text: string; tone: 'ok' | 'warn' | 'danger' | '' } {
  switch (plural) {
    case 'pods': {
      const phase = o.status?.phase ?? 'Unknown';
      const deletionTimestamp = o.metadata?.deletionTimestamp;
      const statuses = (o.status?.containerStatuses ?? []) as Array<{
        ready?: boolean;
        state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number } };
        lastState?: { terminated?: { reason?: string } };
      }>;
      const ready = statuses.filter((c) => c.ready).length;
      const total = statuses.length;
      const podConditions = Array.isArray(o.status?.conditions)
        ? (o.status.conditions as Array<{ type?: string; status?: string }>)
        : [];
      const podReady = podConditions.some((c) => c.type === 'Ready' && c.status === 'True');
      const containersReady = total > 0 && ready === total;
      const initialized = !podConditions.some((c) => c.type === 'Initialized' && c.status !== 'True');
      const scheduled = !podConditions.some((c) => c.type === 'PodScheduled' && c.status !== 'True');
      const waitingReason = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason;
      const terminatedReason = statuses.find((c) => c.state?.terminated?.reason)?.state?.terminated?.reason;
      const lastTerminatedReason = statuses.find((c) => c.lastState?.terminated?.reason)?.lastState?.terminated?.reason;

      if (deletionTimestamp) return { text: 'Terminating', tone: 'warn' };
      if (waitingReason) {
        const tone = /CrashLoopBackOff|Err|ImagePullBackOff|CreateContainerConfigError/i.test(waitingReason)
          ? 'danger'
          : 'warn';
        return { text: waitingReason, tone };
      }
      if (terminatedReason) return { text: terminatedReason, tone: 'danger' };
      if (lastTerminatedReason && phase === 'Running' && ready < total) {
        return { text: lastTerminatedReason, tone: 'warn' };
      }

      if (phase === 'Running') {
        if (podReady && containersReady && initialized && scheduled) {
          return { text: 'Running', tone: 'ok' };
        }
        return { text: containersReady ? 'NotReady' : 'Starting', tone: 'warn' };
      }

      if (phase === 'Pending') {
        return { text: 'Starting', tone: 'warn' };
      }

      const tone = phase === 'Running' || phase === 'Succeeded' ? 'ok' : phase === 'Pending' ? 'warn' : 'danger';
      return { text: phase, tone };
    }
    case 'deployments':
    case 'statefulsets': {
      const ready = o.status?.readyReplicas ?? 0;
      const desired = o.spec?.replicas ?? 0;
      const updated = o.status?.updatedReplicas ?? 0;
      const available = o.status?.availableReplicas ?? 0;
      const progressDeadlineExceeded = Array.isArray(o.status?.conditions)
        && o.status.conditions.some((condition: any) => condition.type === 'Progressing' && condition.status === 'False');
      if (progressDeadlineExceeded) return { text: 'Failed', tone: 'danger' };
      if (ready === desired && available === desired && updated === desired && desired > 0) {
        return { text: `${ready}/${desired}`, tone: 'ok' };
      }
      return { text: `Updating ${ready}/${desired}`, tone: 'warn' };
    }
    case 'daemonsets': {
      const ready = o.status?.numberReady ?? 0;
      const desired = o.status?.desiredNumberScheduled ?? 0;
      return { text: `${ready}/${desired}`, tone: ready === desired ? 'ok' : 'warn' };
    }
    case 'replicasets': {
      const ready = o.status?.readyReplicas ?? 0;
      const desired = o.spec?.replicas ?? 0;
      return { text: `${ready}/${desired}`, tone: ready === desired ? 'ok' : '' };
    }
    case 'jobs': {
      const succeeded = o.status?.succeeded ?? 0;
      return { text: succeeded ? 'Complete' : 'Active', tone: succeeded ? 'ok' : 'warn' };
    }
    case 'namespaces': {
      const phase = o.status?.phase ?? 'Unknown';
      return { text: phase, tone: phase === 'Active' ? 'ok' : phase === 'Terminating' ? 'warn' : '' };
    }
    default:
      return { text: '', tone: '' };
  }
}

export function podContainers(o: K8sObject): string[] {
  return (o.spec?.containers ?? []).map((c: any) => c.name);
}
