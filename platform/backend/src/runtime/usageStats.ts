import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logError } from '../util/logger.js';
import { writeFileAtomic } from '../util/fileLock.js';

const USAGE_STATS_FILE = 'usage-stats.json';
const PERSIST_DEBOUNCE_MS = 5000;
const MAX_TRACKED_OPERATIONS = 500;

export interface UsageStats {
  since: string | null;
  totalEvents: number;
  operations: Record<string, number>;
}

let enabled = false;
let loaded = false;
let stats: UsageStats = { since: null, totalEvents: 0, operations: {} };
let persistTimer: NodeJS.Timeout | null = null;

function statsPath(): string {
  return path.join(config.sessionStorageDir, USAGE_STATS_FILE);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(await fsp.readFile(statsPath(), 'utf8')) as Partial<UsageStats>;
    stats = {
      since: typeof parsed.since === 'string' ? parsed.since : null,
      totalEvents: Number(parsed.totalEvents) || 0,
      operations: parsed.operations && typeof parsed.operations === 'object' ? parsed.operations : {},
    };
  } catch {
    // No stats recorded yet.
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeFileAtomic(statsPath(), JSON.stringify(stats)).catch((err) => {
      logError('usage_stats.persist_failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

export async function setUsageTrackingEnabled(value: boolean): Promise<void> {
  enabled = value;
  if (value) await ensureLoaded();
}

/** Counts a feature use on this device only; nothing is transmitted anywhere. */
export function recordUsage(operation: string | undefined | null): void {
  if (!enabled || !loaded || !operation) return;
  if (!(operation in stats.operations) && Object.keys(stats.operations).length >= MAX_TRACKED_OPERATIONS) return;
  stats.since ??= new Date().toISOString();
  stats.totalEvents += 1;
  stats.operations[operation] = (stats.operations[operation] ?? 0) + 1;
  schedulePersist();
}

export async function getUsageStats(): Promise<UsageStats> {
  await ensureLoaded();
  return stats;
}

export async function clearUsageStats(): Promise<void> {
  await ensureLoaded();
  stats = { since: null, totalEvents: 0, operations: {} };
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await fsp.rm(statsPath(), { force: true });
}
