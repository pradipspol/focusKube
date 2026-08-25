import type { ChangeEventDoc } from './types.js';

export interface CorrelatedEvent extends ChangeEventDoc {
  correlatedWith?: {
    kind: string;
    namespace?: string;
    name: string;
    changeType: string;
    minutesBefore: number;
  };
}

export function correlateEvents(events: ChangeEventDoc[], correlationWindowMs = 10 * 60 * 1000): CorrelatedEvent[] {
  const result: CorrelatedEvent[] = [];
  const workloadChanges = events.filter((e) => e.category === 'workloadChange');
  const eventChanges = events.filter((e) => e.category === 'k8sEvent');

  for (const event of eventChanges) {
    const correlated: CorrelatedEvent = { ...event };

    // Find a workload change in the correlation window before this event
    const relatedChange = workloadChanges.find((change) => {
      const timeDiff = event.ts.getTime() - change.ts.getTime();
      return (
        timeDiff > 0 &&
        timeDiff <= correlationWindowMs &&
        change.namespace === event.namespace &&
        (change.name === event.involvedObject?.name || isOwner(change, event.involvedObject))
      );
    });

    if (relatedChange) {
      correlated.correlatedWith = {
        kind: relatedChange.kind,
        namespace: relatedChange.namespace,
        name: relatedChange.name,
        changeType: relatedChange.changeType,
        minutesBefore: Math.round((event.ts.getTime() - relatedChange.ts.getTime()) / 1000 / 60),
      };
    }

    result.push(correlated);
  }

  // Also include workload changes in the result
  result.push(...workloadChanges);

  // Sort by timestamp descending (most recent first)
  result.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  return result;
}

function isOwner(change: ChangeEventDoc, involvedObject?: { kind: string; name: string; namespace?: string }): boolean {
  if (!involvedObject) return false;
  if (change.kind === 'Deployment' && involvedObject.kind === 'Pod') {
    return true;
  }
  if ((change.kind === 'StatefulSet' || change.kind === 'ReplicaSet') && involvedObject.kind === 'Pod') {
    return true;
  }
  return false;
}
