import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logError, logInfo } from '../util/logger.js';
import type { ChangeEventDoc, ChangeRecord } from './types.js';

export interface ChangeEventStore {
  insertChanges(recordingId: string, changes: ChangeRecord[], retentionMs: number, context: string): Promise<void>;
  upsertEvent(recordingId: string, event: ChangeRecord, retentionMs: number, context: string): Promise<void>;
  queryEvents(context: string, from: Date, to: Date, filters?: { namespace?: string; category?: string; severity?: string }): Promise<ChangeEventDoc[]>;
  queryStateAt(context: string, atTime: Date, namespace?: string): Promise<ChangeEventDoc[]>;
}

type SqliteEventRow = Omit<ChangeEventDoc, 'ts' | 'expiresAt' | 'before' | 'after' | 'involvedObject'> & {
  ts: number;
  expiresAt: number;
  before: string | null;
  after: string | null;
  involvedObject: string | null;
};

function parseJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : JSON.parse(value) as T;
}

function fromRow(row: SqliteEventRow): ChangeEventDoc {
  return {
    ...row,
    ts: new Date(row.ts),
    expiresAt: new Date(row.expiresAt),
    before: parseJson<Record<string, unknown>>(row.before),
    after: parseJson<Record<string, unknown>>(row.after),
    involvedObject: parseJson<{ kind: string; name: string; namespace?: string }>(row.involvedObject),
  };
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export class SqliteChangeEventStore implements ChangeEventStore {
  private readonly db: Database.Database;
  private readonly insertStatement: ReturnType<Database.Database['prepare']>;
  private readonly databasePath: string;

  constructor() {
    fs.mkdirSync(config.sessionStorageDir, { recursive: true });
    this.databasePath = path.join(config.sessionStorageDir, 'observability-events.sqlite');
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        recordingId TEXT NOT NULL,
        context TEXT NOT NULL,
        namespace TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        uid TEXT,
        ts INTEGER NOT NULL,
        category TEXT NOT NULL,
        changeType TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        before TEXT,
        after TEXT,
        reason TEXT,
        involvedObject TEXT,
        expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_context_ts ON events(context, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_context_category_ts ON events(context, category, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_recording_event ON events(recordingId, kind, uid);
      CREATE INDEX IF NOT EXISTS idx_events_expires_at ON events(expiresAt);
    `);
    this.insertStatement = this.db.prepare(`INSERT INTO events
      (id, recordingId, context, namespace, kind, name, uid, ts, category, changeType, severity, summary,
       before, after, reason, involvedObject, expiresAt)
      VALUES (@id, @recordingId, @context, @namespace, @kind, @name, @uid, @ts, @category, @changeType,
       @severity, @summary, @before, @after, @reason, @involvedObject, @expiresAt)`);
    logInfo('observability.store.sqlite_opened', {
      databasePath: this.databasePath,
      rowCount: (this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
    });
    this.migrateJsonStore(this.databasePath);
    this.pruneExpired();
  }

  private migrateJsonStore(databasePath: string): void {
    const jsonPath = path.join(config.sessionStorageDir, 'observability-events.json');
    if (!fs.existsSync(jsonPath) || this.db.prepare('SELECT 1 FROM events LIMIT 1').get()) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<Record<string, unknown>>;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO events
        (id, recordingId, context, namespace, kind, name, uid, ts, category, changeType, severity, summary,
         before, after, reason, involvedObject, expiresAt)
        VALUES (@id, @recordingId, @context, @namespace, @kind, @name, @uid, @ts, @category, @changeType,
         @severity, @summary, @before, @after, @reason, @involvedObject, @expiresAt)`);
      const migrate = this.db.transaction((docs: Array<Record<string, unknown>>) => {
        for (const doc of docs) {
          insert.run({
            id: String(doc.id),
            recordingId: String(doc.recordingId),
            context: String(doc.context),
            namespace: doc.namespace ?? null,
            kind: String(doc.kind),
            name: String(doc.name),
            uid: doc.uid ?? null,
            ts: new Date(String(doc.ts)).getTime(),
            category: String(doc.category),
            changeType: String(doc.changeType),
            severity: String(doc.severity),
            summary: String(doc.summary),
            expiresAt: new Date(String(doc.expiresAt)).getTime(),
            before: json(doc.before),
            after: json(doc.after),
            reason: doc.reason ?? null,
            involvedObject: json(doc.involvedObject),
          });
        }
      });
      migrate(parsed);
      logInfo('observability.store.json_migrated', { databasePath, count: parsed.length });
    } catch (err) {
      logError('observability.store.json_migration_failed', {
        jsonPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pruneExpired(): void {
    this.db.prepare('DELETE FROM events WHERE expiresAt <= ?').run(Date.now());
  }

  private rowParams(doc: ChangeEventDoc): Record<string, unknown> {
    return {
      id: doc.id,
      recordingId: doc.recordingId,
      context: doc.context,
      namespace: doc.namespace ?? null,
      kind: doc.kind,
      name: doc.name,
      uid: doc.uid ?? null,
      ts: doc.ts.getTime(),
      category: doc.category,
      changeType: doc.changeType,
      severity: doc.severity,
      summary: doc.summary,
      before: json(doc.before),
      after: json(doc.after),
      reason: doc.reason ?? null,
      involvedObject: json(doc.involvedObject),
      expiresAt: doc.expiresAt.getTime(),
    };
  }

  async insertChanges(recordingId: string, changes: ChangeRecord[], retentionMs: number, context: string): Promise<void> {
    if (changes.length === 0) return;
    const expiresAt = new Date(Date.now() + retentionMs);
    const insertMany = this.db.transaction((records: ChangeRecord[]) => records.forEach((change) => this.insertStatement.run(this.rowParams({ id: crypto.randomUUID(), recordingId, context, ...change, expiresAt }))));
    insertMany(changes);
    logInfo('observability.store.changes_inserted', {
      databasePath: this.databasePath,
      recordingId,
      context,
      count: changes.length,
    });
  }

  async upsertEvent(recordingId: string, event: ChangeRecord, retentionMs: number, context: string): Promise<void> {
    const expiresAt = new Date(Date.now() + retentionMs);
    const updated = this.db.prepare('UPDATE events SET context=@context, namespace=@namespace, name=@name, uid=@uid, ts=@ts, category=@category, changeType=@changeType, severity=@severity, summary=@summary, before=@before, after=@after, reason=@reason, involvedObject=@involvedObject, expiresAt=@expiresAt WHERE uid=@uid AND kind=\'Event\' AND recordingId=@recordingId').run(this.rowParams({ id: '', recordingId, context, ...event, expiresAt }));
    if (!updated.changes) this.insertStatement.run(this.rowParams({ id: crypto.randomUUID(), recordingId, context, ...event, expiresAt }));
    logInfo('observability.store.event_upserted', {
      databasePath: this.databasePath,
      recordingId,
      context,
      uid: event.uid,
      inserted: updated.changes === 0,
    });
  }

  async queryEvents(
    context: string,
    from: Date,
    to: Date,
    filters?: { namespace?: string; category?: string; severity?: string },
  ): Promise<ChangeEventDoc[]> {
    this.pruneExpired();
    const conditions = ['context = ?', 'ts >= ?', 'ts <= ?'];
    const params: unknown[] = [context, from.getTime(), to.getTime()];
    for (const [column, value] of [['namespace', filters?.namespace], ['category', filters?.category], ['severity', filters?.severity]] as const) {
      if (value) { conditions.push(`${column} = ?`); params.push(value); }
    }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY ts DESC`).all(...params) as SqliteEventRow[];
    return rows.map(fromRow);
  }

  async queryStateAt(context: string, atTime: Date, namespace?: string): Promise<ChangeEventDoc[]> {
    this.pruneExpired();
    const matches = this.db.prepare('SELECT * FROM events WHERE context = ? AND category = \'workloadChange\' AND ts <= ?' + (namespace ? ' AND namespace = ?' : '') + ' ORDER BY ts DESC').all(context, atTime.getTime(), ...(namespace ? [namespace] : [])) as SqliteEventRow[];
    const docs = matches.map(fromRow);

    const latestByKey = new Map<string, ChangeEventDoc>();
    for (const doc of docs) {
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

let eventStore: ChangeEventStore | null = null;

export function getChangeEventStore(): ChangeEventStore {
  if (!eventStore) eventStore = new SqliteChangeEventStore();
  return eventStore;
}
