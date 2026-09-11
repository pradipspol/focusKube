import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logError, logInfo } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

const ACCOUNT_STATE_FILE = 'account-session.json';

export interface CachedAccountUser {
  id: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}

interface PersistedAccountState {
  sessionToken?: string | null;
  lastValidatedAt?: number | null;
  cachedUser?: CachedAccountUser | null;
}

let stateLoaded = false;
let stateLoadPromise: Promise<void> | null = null;
let cachedState: PersistedAccountState = {};

function accountStatePath(): string {
  return path.join(config.sessionStorageDir, ACCOUNT_STATE_FILE);
}

async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) return;
  if (!stateLoadPromise) {
    stateLoadPromise = (async () => {
      try {
        const raw = await fsp.readFile(accountStatePath(), 'utf8');
        if (raw.trim()) {
          cachedState = JSON.parse(raw) as PersistedAccountState;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('ENOENT')) {
          // File doesn't exist yet — that's fine
          cachedState = {};
        } else {
          logError('account_session.load_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        stateLoaded = true;
      }
    })();
  }
  await stateLoadPromise;
}

async function persistState(): Promise<void> {
  await ensureStateLoaded();
  try {
    await withFileLock(accountStatePath(), () =>
      writeFileAtomic(accountStatePath(), JSON.stringify(cachedState, null, 2)),
    );
  } catch (err) {
    logError('account_session.persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getSessionToken(): Promise<string | null> {
  await ensureStateLoaded();
  return cachedState.sessionToken || null;
}

export async function setSessionToken(token: string): Promise<void> {
  await ensureStateLoaded();
  const normalized = token.trim();
  if (!normalized) return;
  cachedState.sessionToken = normalized;
  cachedState.lastValidatedAt = null;
  cachedState.cachedUser = null;
  await persistState();
  logInfo('account_session.token_set', {});
}

export async function clearSessionToken(): Promise<void> {
  await ensureStateLoaded();
  cachedState.sessionToken = null;
  cachedState.lastValidatedAt = null;
  cachedState.cachedUser = null;
  await persistState();
  logInfo('account_session.token_cleared', {});
}

export async function getCachedUser(): Promise<CachedAccountUser | null> {
  await ensureStateLoaded();
  return cachedState.cachedUser || null;
}

export async function setCachedUser(user: CachedAccountUser): Promise<void> {
  await ensureStateLoaded();
  cachedState.cachedUser = user;
  cachedState.lastValidatedAt = Date.now();
  await persistState();
}

export async function getCacheAge(): Promise<number> {
  await ensureStateLoaded();
  if (!cachedState.lastValidatedAt) return Infinity;
  return Date.now() - cachedState.lastValidatedAt;
}
