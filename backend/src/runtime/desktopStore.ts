import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SessionScope } from '../auth/session.js';

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
let stateLoaded = false;

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

async function ensureLoaded(): Promise<void> {
  if (stateLoaded) return;
  stateLoaded = true;

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
          region: source.region,
          createdAt: new Date(source.createdAt),
          updatedAt: new Date(source.updatedAt),
        });
      }
    }
  } catch {
    // Best effort only: start with empty desktop state if persistence is missing or invalid.
  }
}

async function persistState(): Promise<void> {
  await ensureLoaded();
  try {
    await fsp.mkdir(config.sessionStorageDir, { recursive: true });
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
          region: doc.region,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
        })),
      };
      
    }

    const payload: PersistedDesktopState = { users };
    await fsp.writeFile(stateFilePath(), JSON.stringify(payload, null, 2), 'utf8');
    
  } catch {
    // Best effort only.
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
  void persistState();
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
  if (existing) void persistState();
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
  void persistState();
  return updated;
}

export async function listDesktopContextSources(userId: string): Promise<DesktopContextSourceDoc[]> {
  await ensureLoaded();
  return Array.from(contextSourcesFor(userId).values());
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
  void persistState();
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
  if (changed) void persistState();
}
