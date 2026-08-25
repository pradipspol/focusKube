import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logError } from '../util/logger.js';

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * A tiny embedded NoSQL document store: each collection is a JSON array file
 * under the desktop session storage dir, loaded into memory on first use and
 * flushed back to disk (debounced) after writes. This replaces MongoDB for
 * the desktop-only build — no server process, no schema, just documents.
 */
export class Collection<T extends { id: string }> {
  private docs: T[] = [];
  private loaded = false;
  private writeScheduled = false;
  private writeInFlight = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private fileName: string,
    private opts: { reviveDates?: Array<keyof T>; ttlKey?: keyof T } = {},
  ) {}

  private filePath(): string {
    return path.join(config.sessionStorageDir, this.fileName);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as T[];
        if (Array.isArray(parsed)) {
          this.docs = parsed.map((doc) => this.reviveDoc(doc));
        }
      }
    } catch (err) {
      logError('store.collection.load_failed', {
        filePath: this.filePath(),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.pruneExpired();
    if (this.opts.ttlKey && !this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();
    }
  }

  private reviveDoc(doc: any): T {
    for (const key of this.opts.reviveDates ?? []) {
      if (doc[key]) doc[key] = new Date(doc[key]);
    }
    return doc as T;
  }

  private pruneExpired(): void {
    const ttlKey = this.opts.ttlKey;
    if (!ttlKey) return;
    const now = Date.now();
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => {
      const value = doc[ttlKey];
      return !(value instanceof Date) || value.getTime() > now;
    });
    if (this.docs.length !== before) this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    setImmediate(() => {
      this.writeScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.writeInFlight) {
      this.scheduleWrite();
      return;
    }
    this.writeInFlight = true;
    try {
      await fsp.mkdir(path.dirname(this.filePath()), { recursive: true });
      await fsp.writeFile(this.filePath(), JSON.stringify(this.docs), 'utf8');
    } catch (err) {
      logError('store.collection.flush_failed', {
        filePath: this.filePath(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.writeInFlight = false;
    }
  }

  find(predicate?: (doc: T) => boolean): T[] {
    this.ensureLoaded();
    return predicate ? this.docs.filter(predicate) : [...this.docs];
  }

  findOne(predicate: (doc: T) => boolean): T | undefined {
    this.ensureLoaded();
    return this.docs.find(predicate);
  }

  insertOne(doc: T): T {
    this.ensureLoaded();
    this.docs.push(doc);
    this.scheduleWrite();
    return doc;
  }

  insertMany(docs: T[]): void {
    if (docs.length === 0) return;
    this.ensureLoaded();
    this.docs.push(...docs);
    this.scheduleWrite();
  }

  updateOne(predicate: (doc: T) => boolean, patch: Partial<T>): T | undefined {
    this.ensureLoaded();
    const existing = this.docs.find(predicate);
    if (!existing) return undefined;
    Object.assign(existing, patch);
    this.scheduleWrite();
    return existing;
  }

  deleteOne(predicate: (doc: T) => boolean): boolean {
    this.ensureLoaded();
    const index = this.docs.findIndex(predicate);
    if (index === -1) return false;
    this.docs.splice(index, 1);
    this.scheduleWrite();
    return true;
  }

  deleteMany(predicate: (doc: T) => boolean): number {
    this.ensureLoaded();
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !predicate(doc));
    const removed = before - this.docs.length;
    if (removed > 0) this.scheduleWrite();
    return removed;
  }
}
