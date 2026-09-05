import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

/**
 * One signed-in Azure "cloud"-scope account, isolated into its own `AZURE_CONFIG_DIR`
 * subfolder. Azure CLI's local profile cache attributes each subscription to exactly one
 * identity - when two accounts share a config dir, whichever one most recently ran `az
 * login`/`az account list --refresh` silently reassigns any subscription both can see. Giving
 * each account its own dir removes the shared cache there is to fight over.
 */
export interface AzureAccountRecord {
  accountId: string; // email.toLowerCase() - stable identity, reused as AzureAccountGroup.id
  email: string; // first-seen display casing
  configDirName: string; // opaque subfolder slug under <userId>/azure/accounts/<configDirName>/.azure
  createdAt: Date;
  updatedAt: Date;
}

type PersistedAzureAccountRecord = Omit<AzureAccountRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

type PersistedAzureAccountsState = {
  users: Record<string, PersistedAzureAccountRecord[]>;
};

const accountsByUser = new Map<string, Map<string, AzureAccountRecord>>();
let loadPromise: Promise<void> | null = null;

function accountsFor(userId: string): Map<string, AzureAccountRecord> {
  const existing = accountsByUser.get(userId);
  if (existing) return existing;
  const created = new Map<string, AzureAccountRecord>();
  accountsByUser.set(userId, created);
  return created;
}

function stateFilePath(): string {
  return path.join(config.sessionStorageDir, 'azure-accounts.json');
}

function accountIdForEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Guards against a race on the very first calls after a server restart: several requests
 * (GET /account, GET /accounts, etc.) can call into this store concurrently, and a plain
 * boolean flag set synchronously before the `await` would let the second caller see
 * "already loaded" and read the still-empty map while the first caller's disk read is still
 * in flight - surfacing as "0 accounts" until some later request re-reads once it's warm.
 * Caching the in-flight promise itself makes every concurrent caller await the same load.
 */
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fsp.readFile(stateFilePath(), 'utf8');
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw) as PersistedAzureAccountsState;
        if (!parsed || typeof parsed !== 'object' || !parsed.users || typeof parsed.users !== 'object') return;

        for (const [userId, records] of Object.entries(parsed.users)) {
          const map = accountsFor(userId);
          for (const record of records ?? []) {
            map.set(record.accountId, {
              accountId: record.accountId,
              email: record.email,
              configDirName: record.configDirName,
              createdAt: new Date(record.createdAt),
              updatedAt: new Date(record.updatedAt),
            });
          }
        }
      } catch {
        // Best effort only: start empty if persistence is missing or invalid.
      }
    })();
  }
  return loadPromise;
}

/**
 * Persist the registry. Throws on failure - callers that are about to delete a config
 * directory need to know whether the record pointing at its replacement actually landed.
 *
 * The snapshot is taken INSIDE the lock so that a persist queued behind another one writes
 * the latest state rather than a stale copy, and the write is atomic so a crash can't leave
 * truncated JSON (which `ensureLoaded` would read as "no accounts at all").
 */
async function persistState(): Promise<void> {
  await ensureLoaded();
  const file = stateFilePath();
  await withFileLock(file, async () => {
    const users: Record<string, PersistedAzureAccountRecord[]> = {};
    for (const [userId, map] of accountsByUser.entries()) {
      // Reads create empty buckets as a side effect; don't persist those.
      if (map.size === 0) continue;
      users[userId] = Array.from(map.values()).map((record) => ({
        accountId: record.accountId,
        email: record.email,
        configDirName: record.configDirName,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      }));
    }
    const payload: PersistedAzureAccountsState = { users };
    await writeFileAtomic(file, JSON.stringify(payload, null, 2));
  });
}

function accountsRootPath(userId: string): string {
  return path.join(config.sessionStorageDir, userId, 'azure', 'accounts');
}

function configDirPath(userId: string, configDirName: string): string {
  return path.join(accountsRootPath(userId), configDirName, '.azure');
}

/**
 * Remove config directories under this user's accounts root that no registered account
 * points at.
 *
 * Every login attempt allocates a candidate directory before the email is known, so an
 * attempt that fails, times out, or is simply abandoned leaves one behind. Without this they
 * accumulate for the life of the install, each holding partial Azure CLI state.
 *
 * Only directories untouched for `minAgeMs` are considered, so a login that is still in
 * flight (in this or any other session) is never pulled out from under itself.
 */
export async function pruneOrphanAzureConfigDirs(userId: string, minAgeMs = 60 * 60 * 1000): Promise<string[]> {
  await ensureLoaded();
  const keep = new Set(Array.from(accountsFor(userId).values()).map((record) => record.configDirName));
  const root = accountsRootPath(userId);
  let entries: string[];
  try {
    entries = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const removed: string[] = [];
  const cutoff = Date.now() - minAgeMs;
  for (const name of entries) {
    if (keep.has(name)) continue;
    const dir = path.join(root, name);
    try {
      const stat = await fsp.stat(dir);
      if (stat.mtimeMs > cutoff) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Best effort: skip anything we can't stat or remove.
    }
  }
  return removed;
}

/**
 * Drop a specific candidate directory that will never be registered (its login failed, was
 * superseded by a new attempt, or could not be reconciled to an email).
 */
export async function discardCandidateAzureConfigDir(userId: string, configDirName: string): Promise<void> {
  await ensureLoaded();
  // Never delete a directory a registered account is actually using.
  for (const record of accountsFor(userId).values()) {
    if (record.configDirName === configDirName) return;
  }
  const dir = path.join(accountsRootPath(userId), configDirName);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function listAzureAccounts(userId: string): Promise<AzureAccountRecord[]> {
  await ensureLoaded();
  return Array.from(accountsFor(userId).values()).sort((a, b) => a.email.localeCompare(b.email));
}

export async function getAzureAccountConfigDir(userId: string, accountId: string): Promise<string | undefined> {
  await ensureLoaded();
  const record = accountsFor(userId).get(accountId);
  return record ? configDirPath(userId, record.configDirName) : undefined;
}

/**
 * Allocate a fresh, not-yet-registered config dir for an in-flight login attempt. The device
 * code flow doesn't reveal which email will complete login until after the user finishes in the
 * browser, so every login attempt (new account or reconnect) starts against a throwaway
 * candidate dir; `registerOrPromoteAzureAccount` reconciles it by email once login succeeds.
 */
export async function allocateCandidateAzureConfigDir(userId: string): Promise<{ configDirName: string; dir: string }> {
  await ensureLoaded();
  // A full UUID, not a truncation of one: this names a directory that will hold an account's
  // credentials, and there is no cheap way to detect having silently reused another
  // account's directory after the fact.
  const taken = new Set(Array.from(accountsFor(userId).values()).map((record) => record.configDirName));
  let configDirName = crypto.randomUUID();
  while (taken.has(configDirName)) configDirName = crypto.randomUUID();
  const dir = configDirPath(userId, configDirName);
  await fsp.mkdir(dir, { recursive: true });
  return { configDirName, dir };
}

/**
 * Reconcile a just-completed login against the registry by email. If this email already owns a
 * different dir, promote the candidate to be its new canonical dir (fresher tokens) and
 * best-effort clean up the superseded one - existing imported contexts reference `accountId`/
 * `subscriptionId`, never a raw path, so swapping the underlying dir orphans nothing.
 */
export async function registerOrPromoteAzureAccount(
  userId: string,
  email: string,
  candidateConfigDirName: string,
): Promise<AzureAccountRecord> {
  await ensureLoaded();
  const accountId = accountIdForEmail(email);
  const map = accountsFor(userId);
  const existing = map.get(accountId);
  const now = new Date();
  const record: AzureAccountRecord = {
    accountId,
    email: existing?.email ?? email,
    configDirName: candidateConfigDirName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  map.set(accountId, record);
  // Persist BEFORE deleting the superseded directory. The other order can lose the account
  // outright: the old dir is gone for certain while the record naming its replacement was
  // only best-effort, so a restart would find a registry pointing at nothing.
  try {
    await persistState();
  } catch (err) {
    // Roll the in-memory map back so it can't disagree with what's on disk, and leave the
    // old directory alone - the caller surfaces this and the account stays usable.
    if (existing) map.set(accountId, existing);
    else map.delete(accountId);
    throw err;
  }

  if (existing && existing.configDirName !== candidateConfigDirName) {
    const staleDir = configDirPath(userId, existing.configDirName);
    await fsp.rm(staleDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return record;
}

export async function deregisterAzureAccount(userId: string, email: string): Promise<void> {
  await ensureLoaded();
  const accountId = accountIdForEmail(email);
  const map = accountsFor(userId);
  const existing = map.get(accountId);
  if (!existing) return;
  map.delete(accountId);
  // Same ordering rule as above: only remove the credentials once the removal is durable,
  // otherwise a restart resurrects a record whose directory no longer exists.
  try {
    await persistState();
  } catch (err) {
    map.set(accountId, existing);
    throw err;
  }
  const dir = configDirPath(userId, existing.configDirName);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
