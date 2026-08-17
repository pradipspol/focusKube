import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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
        sourceMap.set(source.contextName, {
          contextName: source.contextName,
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
  const existing = store.get(source.contextName);
  store.set(source.contextName, {
    ...source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  void persistState();
}

export async function deleteDesktopContextSourcesForNames(userId: string, names: Iterable<string>): Promise<void> {
  await ensureLoaded();
  const store = contextSourcesFor(userId);
  let changed = false;
  for (const name of names) {
    changed = store.delete(name) || changed;
  }
  if (changed) void persistState();
}
