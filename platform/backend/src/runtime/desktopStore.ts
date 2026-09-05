import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SessionScope } from '../auth/session.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { logError } from '../util/logger.js';

export interface DesktopLocalKubeconfigDoc {
  id: string;
  name: string;
  nameLower: string;
  content: string;
  contexts: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DesktopContextSourceDoc {
  contextName: string;
  // Which per-scope kubeconfig file this context lives in. Context names are only
  // unique within a single kubeconfig file, so a name alone is not a safe key: the
  // same string can name two entirely different clusters in the local vs. the
  // azure/aws-managed kubeconfig files.
  scope: SessionScope;
  source: 'aks' | 'eks';
  subscriptionId?: string;
  subscriptionName?: string;
  resourceGroup?: string;
  clusterName?: string;
  accountId?: string;
  tenantId?: string;
  tenantName?: string;
  region?: string;
  createdAt: Date;
  updatedAt: Date;
}

type PersistedDesktopUserState = {
  localKubeconfigs: Array<Omit<DesktopLocalKubeconfigDoc, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }>;
  contextSources: Array<Omit<DesktopContextSourceDoc, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }>;
};

type PersistedDesktopState = {
  users: Record<string, PersistedDesktopUserState>;
};

const localKubeconfigsByUser = new Map<string, Map<string, DesktopLocalKubeconfigDoc>>();
const contextSourcesByUser = new Map<string, Map<string, DesktopContextSourceDoc>>();
let loadPromise: Promise<void> | null = null;

function localKubeconfigsFor(userId: string): Map<string, DesktopLocalKubeconfigDoc> {
  const existing = localKubeconfigsByUser.get(userId);
  if (existing) return existing;
  const created = new Map<string, DesktopLocalKubeconfigDoc>();
  localKubeconfigsByUser.set(userId, created);
  return created;
}

function contextSourcesFor(userId: string): Map<string, DesktopContextSourceDoc> {
  const existing = contextSourcesByUser.get(userId);
  if (existing) return existing;
  const created = new Map<string, DesktopContextSourceDoc>();
  contextSourcesByUser.set(userId, created);
  return created;
}

// Context names are only unique within a single kubeconfig file. Key the store by
// (scope, name) so a same-named context in a different scope's kubeconfig never
// shares or overwrites another scope's source metadata.
function contextSourceKey(scope: SessionScope, contextName: string): string {
  return `${scope}::${contextName}`;
}

function stateFilePath(): string {
  return path.join(config.sessionStorageDir, 'desktop-state.json');
}

function contextFilePath(name: string = 'temp'): string {
  return path.join(config.sessionStorageDir, name);
}

/**
 * Guards against a race on the very first calls after a server restart: several requests
 * can call into this store concurrently, and a plain boolean flag set synchronously before
 * the `await` would let a second caller see "already loaded" and read the still-empty maps
 * while the first caller's disk read is still in flight - surfacing as missing context
 * sources (e.g. an account tag lookup silently missing) until a later request re-reads once
 * it's warm. Caching the in-flight promise itself makes every concurrent caller await the
 * same load.
 */
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fsp.readFile(stateFilePath(), 'utf8');
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw) as PersistedDesktopState;
        if (!parsed || typeof parsed !== 'object' || !parsed.users || typeof parsed.users !== 'object') return;

        for (const [userId, userState] of Object.entries(parsed.users)) {
          const localMap = localKubeconfigsFor(userId);
          for (const doc of userState.localKubeconfigs ?? []) {
            localMap.set(doc.id, {
              id: doc.id,
              name: doc.name,
              nameLower: doc.nameLower,
              content: doc.content,
              contexts: Array.isArray(doc.contexts) ? doc.contexts : [],
              createdAt: new Date(doc.createdAt),
              updatedAt: new Date(doc.updatedAt),
            });
          }

          const sourceMap = contextSourcesFor(userId);
          for (const source of userState.contextSources ?? []) {
            // Older persisted state predates per-scope keying; back-fill scope from the
            // provider, since 'aks' docs were always written for the azure scope and
            // 'eks' docs for the aws scope.
            const scope: SessionScope = source.scope ?? (source.source === 'eks' ? 'aws' : 'azure');
            sourceMap.set(contextSourceKey(scope, source.contextName), {
              contextName: source.contextName,
              scope,
              source: source.source,
              subscriptionId: source.subscriptionId,
              subscriptionName: source.subscriptionName,
              resourceGroup: source.resourceGroup,
              clusterName: source.clusterName,
              accountId: source.accountId,
              tenantId: source.tenantId,
              tenantName: source.tenantName,
              region: source.region,
              createdAt: new Date(source.createdAt),
              updatedAt: new Date(source.updatedAt),
            });
          }
        }
      } catch {
        // Best effort only: start with empty desktop state if persistence is missing or invalid.
      }
    })();
  }
  return loadPromise;
}

async function persistState(): Promise<void> {
  await ensureLoaded();
  const file = stateFilePath();
  try {
    // Serialized and atomic: several mutation paths persist concurrently (e.g. signing out
    // loops over accounts, each removing context tags), and two overlapping in-place writes
    // can interleave into invalid JSON - which `ensureLoaded` would then read as "no state
    // at all", silently dropping every stored kubeconfig and context tag. The snapshot is
    // taken inside the lock so a queued persist writes current state, not a stale copy.
    await withFileLock(file, async () => {
      const users: Record<string, PersistedDesktopUserState> = {};
      const userIds = new Set([...localKubeconfigsByUser.keys(), ...contextSourcesByUser.keys()]);
      for (const userId of userIds) {
        users[userId] = {
          localKubeconfigs: Array.from(localKubeconfigsFor(userId).values()).map((doc) => ({
            id: doc.id,
            name: doc.name,
            nameLower: doc.nameLower,
            content: doc.content,
            contexts: doc.contexts,
            createdAt: doc.createdAt.toISOString(),
            updatedAt: doc.updatedAt.toISOString(),
          })),
          contextSources: Array.from(contextSourcesFor(userId).values()).map((doc) => ({
            contextName: doc.contextName,
            scope: doc.scope,
            source: doc.source,
            subscriptionId: doc.subscriptionId,
            subscriptionName: doc.subscriptionName,
            resourceGroup: doc.resourceGroup,
            clusterName: doc.clusterName,
            accountId: doc.accountId,
            tenantId: doc.tenantId,
            tenantName: doc.tenantName,
            region: doc.region,
            createdAt: doc.createdAt.toISOString(),
            updatedAt: doc.updatedAt.toISOString(),
          })),
        };
      }

      const payload: PersistedDesktopState = { users };
      await writeFileAtomic(file, JSON.stringify(payload, null, 2));
    });
  } catch (err) {
    // Still best-effort (the in-memory state is already updated and the request should not
    // fail), but no longer silent - losing this write loses per-context account tags, which
    // downgrades live auth to the legacy shared config dir.
    logError('desktop_store.persist_failed', {
      stateFilePath: file,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listDesktopLocalKubeconfigs(userId: string): Promise<DesktopLocalKubeconfigDoc[]> {
  await ensureLoaded();
  return Array.from(localKubeconfigsFor(userId).values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function upsertDesktopLocalKubeconfig(
  userId: string,
  input: { name: string; content: string; contexts: string[] },
): Promise<DesktopLocalKubeconfigDoc> {
  await ensureLoaded();
  const now = new Date();
  const store = localKubeconfigsFor(userId);
  const nameLower = input.name.toLowerCase();
  const existing = Array.from(store.values()).find((doc) => doc.nameLower === nameLower);
  const doc: DesktopLocalKubeconfigDoc = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name,
    nameLower,
    content: input.content,
    contexts: input.contexts,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.set(doc.id, doc);
  await persistState();
  return doc;
}

export async function findDesktopLocalKubeconfig(userId: string, id: string): Promise<DesktopLocalKubeconfigDoc | undefined> {
  await ensureLoaded();
  return localKubeconfigsFor(userId).get(id);
}

export async function deleteDesktopLocalKubeconfig(userId: string, id: string): Promise<DesktopLocalKubeconfigDoc | undefined> {
  await ensureLoaded();
  const store = localKubeconfigsFor(userId);
  const existing = store.get(id);
  store.delete(id);
  if (existing) await persistState();
  return existing;
}

export async function replaceDesktopLocalKubeconfigContexts(
  userId: string,
  id: string,
  content: string,
  contexts: string[],
): Promise<DesktopLocalKubeconfigDoc | undefined> {
  await ensureLoaded();
  const store = localKubeconfigsFor(userId);
  const existing = store.get(id);
  if (!existing) return undefined;
  const updated: DesktopLocalKubeconfigDoc = {
    ...existing,
    content,
    contexts,
    updatedAt: new Date(),
  };
  store.set(id, updated);
  await persistState();
  return updated;
}

export async function listDesktopContextSources(userId: string): Promise<DesktopContextSourceDoc[]> {
  await ensureLoaded();
  return Array.from(contextSourcesFor(userId).values());
}

export async function getDesktopContextSource(
  userId: string,
  scope: SessionScope,
  contextName: string,
): Promise<DesktopContextSourceDoc | undefined> {
  await ensureLoaded();
  return contextSourcesFor(userId).get(contextSourceKey(scope, contextName));
}

export async function upsertDesktopContextSource(
  userId: string,
  source: Omit<DesktopContextSourceDoc, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  await ensureLoaded();
  const now = new Date();
  const store = contextSourcesFor(userId);
  const key = contextSourceKey(source.scope, source.contextName);
  const existing = store.get(key);
  store.set(key, {
    ...source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await persistState();
}

export async function deleteDesktopContextSourcesForNames(
  userId: string,
  scope: SessionScope,
  names: Iterable<string>,
): Promise<void> {
  await ensureLoaded();
  const store = contextSourcesFor(userId);
  let changed = false;
  for (const name of names) {
    changed = store.delete(contextSourceKey(scope, name)) || changed;
  }
  if (changed) await persistState();
}
