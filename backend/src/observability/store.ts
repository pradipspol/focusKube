import crypto from 'node:crypto';
import { Collection } from '../db/localStore.js';
import type { ChangeEventDoc, ChangeRecord } from './types.js';

export interface ChangeEventStore {
  insertChanges(recordingId: string, changes: ChangeRecord[], retentionMs: number, context: string): Promise<void>;
  upsertEvent(recordingId: string, event: ChangeRecord, retentionMs: number, context: string): Promise<void>;
  queryEvents(context: string, from: Date, to: Date, filters?: { namespace?: string; category?: string; severity?: string }): Promise<ChangeEventDoc[]>;
  queryStateAt(context: string, atTime: Date, namespace?: string): Promise<ChangeEventDoc[]>;
}

let eventsCollection: Collection<ChangeEventDoc> | null = null;

function events(): Collection<ChangeEventDoc> {
  if (!eventsCollection) {
    eventsCollection = new Collection<ChangeEventDoc>('observability-events.json', {
      reviveDates: ['ts', 'expiresAt'],
      ttlKey: 'expiresAt',
    });
  }
  return eventsCollection;
}

export class LocalChangeEventStore implements ChangeEventStore {
  async insertChanges(recordingId: string, changes: ChangeRecord[], retentionMs: number, context: string): Promise<void> {
    if (changes.length === 0) return;
    const expiresAt = new Date(Date.now() + retentionMs);
    const docs: ChangeEventDoc[] = changes.map((change) => ({
      id: crypto.randomUUID(),
      recordingId,
      context,
      ...change,
      expiresAt,
    }));
    events().insertMany(docs);
  }

  async upsertEvent(recordingId: string, event: ChangeRecord, retentionMs: number, context: string): Promise<void> {
    const expiresAt = new Date(Date.now() + retentionMs);
    const patch: Partial<ChangeEventDoc> = { recordingId, context, ...event, expiresAt };
    const updated = events().updateOne(
      (doc) => doc.uid === event.uid && doc.kind === 'Event' && doc.recordingId === recordingId,
      patch,
    );
    if (!updated) {
      events().insertOne({ id: crypto.randomUUID(), ...patch } as ChangeEventDoc);
    }
  }

  async queryEvents(
    context: string,
    from: Date,
    to: Date,
    filters?: { namespace?: string; category?: string; severity?: string },
  ): Promise<ChangeEventDoc[]> {
    return events()
      .find(
        (doc) =>
          doc.context === context &&
          doc.ts.getTime() >= from.getTime() &&
          doc.ts.getTime() <= to.getTime() &&
          (!filters?.namespace || doc.namespace === filters.namespace) &&
          (!filters?.category || doc.category === filters.category) &&
          (!filters?.severity || doc.severity === filters.severity),
      )
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }

  async queryStateAt(context: string, atTime: Date, namespace?: string): Promise<ChangeEventDoc[]> {
    const matches = events().find(
      (doc) =>
        doc.context === context &&
        doc.category === 'workloadChange' &&
        doc.ts.getTime() <= atTime.getTime() &&
        (!namespace || doc.namespace === namespace),
    );

    const latestByKey = new Map<string, ChangeEventDoc>();
    for (const doc of matches) {
      const key = `${doc.kind}:${doc.namespace ?? ''}:${doc.name}`;
      const current = latestByKey.get(key);
      if (!current || doc.ts.getTime() > current.ts.getTime()) {
        latestByKey.set(key, doc);
      }
    }

    return Array.from(latestByKey.values())
      .filter((doc) => doc.changeType !== 'deleted')
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }
}

export function getChangeEventStore(): ChangeEventStore {
  return new LocalChangeEventStore();
}
