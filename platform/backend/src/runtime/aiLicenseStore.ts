import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logError, logInfo } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

const AI_LICENSE_STATE_FILE = 'ai-license.json';

interface PersistedAiLicenseState {
  licenseKey?: string | null;
  lastValidatedAt?: number | null;
  lastEntitlement?: {
    plan?: string;
    status?: string;
    quotaRemaining?: number;
  } | null;
}

let licenseStateLoaded = false;
let licenseStateLoadPromise: Promise<void> | null = null;
let cachedLicenseState: PersistedAiLicenseState = {};

function aiLicenseStatePath(): string {
  return path.join(config.sessionStorageDir, AI_LICENSE_STATE_FILE);
}

async function ensureLicenseStateLoaded(): Promise<void> {
  if (licenseStateLoaded) return;
  if (!licenseStateLoadPromise) {
    licenseStateLoadPromise = (async () => {
      try {
        const raw = await fsp.readFile(aiLicenseStatePath(), 'utf8');
        if (raw.trim()) {
          cachedLicenseState = JSON.parse(raw) as PersistedAiLicenseState;
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('ENOENT')
        ) {
          // File doesn't exist yet — that's fine
          cachedLicenseState = {};
        } else {
          logError('ai_license.load_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        licenseStateLoaded = true;
      }
    })();
  }
  await licenseStateLoadPromise;
}

async function persistLicenseState(): Promise<void> {
  await ensureLicenseStateLoaded();
  try {
    await withFileLock(aiLicenseStatePath(), () =>
      writeFileAtomic(aiLicenseStatePath(), JSON.stringify(cachedLicenseState, null, 2)),
    );
  } catch (err) {
    logError('ai_license.persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getLicenseKey(): Promise<string | null> {
  await ensureLicenseStateLoaded();
  return cachedLicenseState.licenseKey || null;
}

export async function setLicenseKey(key: string): Promise<void> {
  await ensureLicenseStateLoaded();
  const normalized = key.trim();
  if (!normalized) return;
  if (cachedLicenseState.licenseKey === normalized) return;
  cachedLicenseState.licenseKey = normalized;
  cachedLicenseState.lastValidatedAt = null;
  cachedLicenseState.lastEntitlement = null;
  await persistLicenseState();
  logInfo('ai_license.key_set', { keyPrefix: normalized.slice(0, 20) });
}

export async function clearLicenseKey(): Promise<void> {
  await ensureLicenseStateLoaded();
  cachedLicenseState.licenseKey = null;
  cachedLicenseState.lastValidatedAt = null;
  cachedLicenseState.lastEntitlement = null;
  await persistLicenseState();
  logInfo('ai_license.key_cleared');
}

export async function getCachedEntitlement(): Promise<{
  plan?: string;
  status?: string;
  quotaRemaining?: number;
} | null> {
  await ensureLicenseStateLoaded();
  return cachedLicenseState.lastEntitlement || null;
}

export async function setCachedEntitlement(entitlement: {
  plan?: string;
  status?: string;
  quotaRemaining?: number;
}): Promise<void> {
  await ensureLicenseStateLoaded();
  cachedLicenseState.lastEntitlement = entitlement;
  cachedLicenseState.lastValidatedAt = Date.now();
  await persistLicenseState();
}

export async function getCacheAge(): Promise<number> {
  await ensureLicenseStateLoaded();
  if (!cachedLicenseState.lastValidatedAt) return Infinity;
  return Date.now() - cachedLicenseState.lastValidatedAt;
}
