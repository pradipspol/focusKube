import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logError } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { getSessionToken } from './accountStore.js';

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

export interface EntitlementState {
  licenseKey: string | null;
  plan?: string;
  status?: string;
  quotaRemaining?: number;
  error?: string;
}

interface RelayLicense {
  key: string;
  plan: string;
  status: string;
  quotaRemaining: number;
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
        if (err instanceof Error && err.message.includes('ENOENT')) {
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

function cachedState(extra?: { error?: string }): EntitlementState {
  return {
    licenseKey: cachedLicenseState.licenseKey ?? null,
    plan: cachedLicenseState.lastEntitlement?.plan,
    status: cachedLicenseState.lastEntitlement?.status,
    quotaRemaining: cachedLicenseState.lastEntitlement?.quotaRemaining,
    ...extra,
  };
}

async function setEntitlement(license: RelayLicense | null): Promise<void> {
  cachedLicenseState.licenseKey = license?.key ?? null;
  cachedLicenseState.lastEntitlement = license
    ? { plan: license.plan, status: license.status, quotaRemaining: license.quotaRemaining }
    : null;
  cachedLicenseState.lastValidatedAt = Date.now();
  await persistLicenseState();
}

/**
 * Fetches the signed-in account's license from the relay (the license is 1:1 with the
 * account — see relay's licenseStore.ts createLicenseForUser) and caches it. Unlike the
 * old paste-a-key flow, there's nothing here for a 401 to invalidate: the account session
 * itself is auth/session.ts's concern, not this module's — a stale/revoked session just
 * falls through to "no entitlement" here until session.ts's own check catches it.
 */
async function refreshFromRelay(): Promise<EntitlementState> {
  const token = await getSessionToken();
  if (!token) {
    await setEntitlement(null);
    return cachedState();
  }

  try {
    const response = await fetch(`${config.aiRelayBaseUrl}/v1/account`, {
      headers: { Cookie: `${config.accountSessionCookieName}=${token}` },
    });

    if (!response.ok) {
      logError('ai_license.relay_error', { status: response.status });
      return cachedState({ error: 'Could not verify license (offline grace period)' });
    }

    const body = (await response.json()) as { license: RelayLicense | null };
    await setEntitlement(body.license);
    return cachedState();
  } catch (err) {
    logError('ai_license.relay_unreachable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return cachedState({ error: 'Could not verify license (offline grace period)' });
  }
}

/**
 * Cache-fresh entitlement, revalidating against the relay when stale. A currently-active
 * license is trusted longer (aiLicenseCheckCacheMs) than a not-active one
 * (aiLicenseCheckNegativeCacheMs), so a freshly-purchased license is picked up quickly
 * without hammering the relay once entitled.
 */
export async function getEntitlementState(): Promise<EntitlementState> {
  if (config.aiLicenseDevBypassKey) {
    return { licenseKey: config.aiLicenseDevBypassKey, plan: 'dev', status: 'active' };
  }

  await ensureLicenseStateLoaded();
  const lastValidatedAt = cachedLicenseState.lastValidatedAt;
  if (lastValidatedAt == null) {
    return refreshFromRelay();
  }
  const cacheAge = Date.now() - lastValidatedAt;
  const wasActive = cachedLicenseState.lastEntitlement?.status === 'active';
  const ttl = wasActive ? config.aiLicenseCheckCacheMs : config.aiLicenseCheckNegativeCacheMs;
  if (cacheAge <= ttl) {
    return cachedState();
  }
  return refreshFromRelay();
}

export async function getLicenseKey(): Promise<string | null> {
  return (await getEntitlementState()).licenseKey;
}
