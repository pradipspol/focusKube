import { Router } from 'express';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import { z } from 'zod';
import { kube } from '../kube/client.js';
import { removeContextsFromKubeconfigFile } from '../kube/kubeconfigFile.js';
import { repairKubeconfigContent } from '../kube/kubeConfigRepair.js';
import { badRequest, notFound } from '../util/httpError.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { setRequestOperation } from '../util/requestOp.js';
import { config } from '../config.js';
import {
  activeSessionKubeconfigPath,
  setSessionContextSourceHint,
  resolveSessionScopeForContext,
  kubeconfigPathForSource,
  type SessionScope,
} from '../auth/session.js';
import { logInfo, logWarn, logError } from '../util/logger.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import {
  deleteDesktopContextSourcesForNames,
  deleteDesktopLocalKubeconfig,
  findDesktopLocalKubeconfig,
  listDesktopContextSources,
  listDesktopLocalKubeconfigs,
  replaceDesktopLocalKubeconfigContexts,
  upsertDesktopContextSource,
  upsertDesktopLocalKubeconfig,
} from '../runtime/desktopStore.js';
import { contextsService, type ContextsPayload } from '../services/contextsService.js';

export const contextsRouter = Router();

function requireUserKey(req: any): string {
  return contextsService.requireUserKey(req.authUser?.id);
}

function parseKubeconfigContexts(content: string): string[] {
  return contextsService.parseKubeconfigContexts(content);
}

async function listLocalKubeconfigsForUser(userKey: string) {
  const docs = await listDesktopLocalKubeconfigs(userKey);
  return contextsService.mapLocalKubeconfigs(docs);
}

async function removeContextSourcesForNames(
  userKey: string,
  scope: SessionScope,
  names: Iterable<string>,
): Promise<void> {
  const contextNames = Array.from(new Set(Array.from(names).filter((name) => !!name)));
  if (contextNames.length === 0) return;
  await deleteDesktopContextSourcesForNames(userKey, scope, contextNames);
}

function mergeKubeconfigContent(existingContent: string, incomingContent: string): string {
  let existing: any = {};
  try {
    existing = yaml.load(existingContent) ?? {};
  } catch {
    existing = {};
  }

  const incoming = yaml.load(incomingContent) as any;
  if (!incoming || typeof incoming !== 'object') throw badRequest('Stored kubeconfig is invalid');

  const mergeNamedEntries = (current: unknown, additions: unknown) => {
    const byName = new Map<string, any>();
    for (const entry of Array.isArray(current) ? current : []) {
      if (entry?.name) byName.set(entry.name, entry);
    }
    for (const entry of Array.isArray(additions) ? additions : []) {
      if (entry?.name) byName.set(entry.name, entry);
    }
    return Array.from(byName.values());
  };

  return yaml.dump({
    ...existing,
    apiVersion: existing.apiVersion ?? incoming.apiVersion ?? 'v1',
    kind: existing.kind ?? incoming.kind ?? 'Config',
    clusters: mergeNamedEntries(existing.clusters, incoming.clusters),
    users: mergeNamedEntries(existing.users, incoming.users),
    contexts: mergeNamedEntries(existing.contexts, incoming.contexts),
  });
}

async function contextsPayload(req: any, options: { skipConnectivity?: boolean } = {}) {
  const startedHr = process.hrtime.bigint();
  const userKey = requireUserKey(req);
  const skipConnectivity = !!options.skipConnectivity;

  // Local, Azure (cloud), and AWS contexts each live in their own kubeconfig file —
  // merge all three so the context switcher always shows every connected cluster,
  // not just the ones from whichever scope happens to be active right now.
  const sources: Array<{ path: string; scope: SessionScope }> = [
    { path: req.userSession.localKubeconfigPath, scope: 'local' },
    { path: req.userSession.minikubeKubeconfigPath, scope: 'minikube' },
    { path: req.userSession.cloudKubeconfigPath, scope: 'azure' },
    { path: req.userSession.awsKubeconfigPath, scope: 'aws' },
  ];

  const contextsStartedHr = process.hrtime.bigint();
  const entries = (
    await Promise.all(
      sources.map(async ({ path, scope }) => {
        try {
          const ctxs = await kube.getContexts(path, req.userSession.activeContext);
          return ctxs.map((ctx) => ({ ctx, scope }));
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  const contexts = entries.map((entry) => entry.ctx);
  logInfo('contexts.payload.step', {
    reqId: req.logRequestId ?? null,
    step: 'contexts_loaded',
    contextCount: contexts.length,
    elapsedMs: Number((Number(process.hrtime.bigint() - contextsStartedHr) / 1_000_000).toFixed(1)),
  });

  const names = contexts.map((ctx) => ctx.name);

  // Keyed by (scope, name): a context name is only unique within one kubeconfig
  // file, so the same name in two different scopes must not share source metadata
  // (e.g. an unrelated local context must not inherit another cluster's AKS tag
  // just because it happens to have the same name as one imported via Azure).
  const entryKeys = new Set(entries.map((entry) => `${entry.scope}::${entry.ctx.name}`));

  const sourcesStartedHr = process.hrtime.bigint();
  const sourceDocs = names.length
    ? (await listDesktopContextSources(userKey)).filter((doc) => entryKeys.has(`${doc.scope}::${doc.contextName}`))
    : [];
  logInfo('contexts.payload.step', {
    reqId: req.logRequestId ?? null,
    step: 'sources_loaded',
    sourceCount: sourceDocs.length,
    elapsedMs: Number((Number(process.hrtime.bigint() - sourcesStartedHr) / 1_000_000).toFixed(1)),
  });

  const connectivityStartedHr = process.hrtime.bigint();
  const connectivity = skipConnectivity
    ? contexts.map((ctx) => ({ name: ctx.name, connected: false }))
    : contexts.map((ctx) => ({ name: ctx.name, connected: false }));
  logInfo('contexts.payload.step', {
    reqId: req.logRequestId ?? null,
    step: 'connectivity_checked',
    contextCount: connectivity.length,
    skipped: true,
    elapsedMs: Number((Number(process.hrtime.bigint() - connectivityStartedHr) / 1_000_000).toFixed(1)),
  });

  const localConfigsStartedHr = process.hrtime.bigint();
  const localKubeconfigs = await listLocalKubeconfigsForUser(userKey);
  logInfo('contexts.payload.step', {
    reqId: req.logRequestId ?? null,
    step: 'local_kubeconfigs_loaded',
    localCount: localKubeconfigs.length,
     elapsedMs: Number((Number(process.hrtime.bigint() - localConfigsStartedHr) / 1_000_000).toFixed(1)),
  });

  logInfo('contexts.payload.finish', {
    reqId: req.logRequestId ?? null,
    contextCount: contexts.length,
    elapsedMs: Number((Number(process.hrtime.bigint() - startedHr) / 1_000_000).toFixed(1)),
  });

  return contextsService.buildPayload({
    activeContext: req.userSession.activeContext,
    entries,
    sourceDocs,
    localKubeconfigs,
    skipConnectivity,
  });
}

export function invalidateContextsCache(req: any): void {
  contextsService.invalidateCache(req.userSession.userId);
}

async function probeConnectivity(contextName: string, req: any): Promise<boolean> {
  const startedHr = process.hrtime.bigint();
  let timedOut = false;

  const connected = await withTimeoutFallback(
    kube.isContextConnected(contextName, activeSessionKubeconfigPath(req.userSession)),
    config.k8sContextProbeTimeoutMs + 250,
    false,
    () => {
      timedOut = true;
    },
  );

  const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
  if (timedOut) {
    logError('contexts.payload.connectivity.timeout', {
      reqId: req.logRequestId ?? null,
      contextName,
      timeoutMs: config.k8sContextProbeTimeoutMs + 250,
      elapsedMs: Number(elapsedMs.toFixed(1)),
    });
  } else {
    logInfo('contexts.payload.connectivity.result', {
      reqId: req.logRequestId ?? null,
      contextName,
      connected,
      elapsedMs: Number(elapsedMs.toFixed(1)),
    });
  }

  return connected;
}

async function withTimeoutFallback<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

contextsRouter.get('/', withRouteErrorLogging('contexts', 'GET /', async (req, res) => {
  setRequestOperation(req, 'contexts.list');
  if (!req.userSession) throw badRequest('Session not found');
  res.json(
    await contextsService.getCachedPayload(
      req.userSession.userId,
      () => contextsPayload(req),
      () => contextsPayload(req, { skipConnectivity: true }),
      (err) => {
        logWarn('contexts.cache.refresh_failed', {
          reqId: req.logRequestId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    ),
  );
}));

contextsRouter.post('/active', withRouteErrorLogging('contexts', 'POST /active', async (req, res) => {
  setRequestOperation(req, 'contexts.set_active');
  if (!req.userSession) throw badRequest('Session not found');
  const body = z
    .object({
      name: z.string().min(1),
      source: z.enum(['local', 'minikube', 'cloud', 'aws']).optional(),
    })
    .safeParse(req.body);
  if (!body.success) throw badRequest('name is required');
  // Resolve the correct source by probing both kubeconfigs when not explicitly provided.
  const resolvedSource = await resolveSessionScopeForContext(
    req.userSession,
    body.data.name,
    body.data.source ?? null,
  );
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, resolvedSource);

  // Desktop mode: if the local kubeconfig file is empty or doesn't contain the
  // requested context (session was freshly created on page refresh), restore it
  // automatically from the persisted desktop store.
  if (resolvedSource === 'local') {
    const localContexts = await kube.getContexts(selectedKubeconfigPath).catch(() => []);
    if (!localContexts.some((ctx) => ctx.name === body.data.name)) {
      const userKey = requireUserKey(req);
      const storedKubeconfigs = await listDesktopLocalKubeconfigs(userKey);
      const match = storedKubeconfigs.find((doc) => doc.contexts.includes(body.data.name));
      if (match) {
        // Restore kubeconfig from desktop store and repair deprecated flags
        const repairedContent = repairKubeconfigContent(match.content, req.userSession.localAzureConfigDir);
        logInfo('contexts.active.repair_applied', {
          reqId: req.logRequestId ?? null,
          kubeconfigName: match.name,
          originalLength: match.content.length,
          repairedLength: repairedContent.length,
          changed: match.content !== repairedContent,
        });
        await withFileLock(selectedKubeconfigPath, () => writeFileAtomic(selectedKubeconfigPath, repairedContent));
        kube.invalidateLoadConfigCache(selectedKubeconfigPath);
        logInfo('contexts.active.restored_local_kubeconfig', {
          reqId: req.logRequestId ?? null,
          contextName: body.data.name,
          kubeconfigName: match.name,
        });
      }
    }
  }

  // Validate that the selected context exists and is usable for this session's kubeconfig.
  await kube.rawConfig(body.data.name, {
    kubeconfigPath: selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
  });
  req.userSession.activeContext = body.data.name;
  req.userSession.activeContextSource = resolvedSource;
  setSessionContextSourceHint(req.userSession, body.data.name, resolvedSource);
  res.json({ active: req.userSession.activeContext });
}));

contextsRouter.post('/disconnect', withRouteErrorLogging('contexts', 'POST /disconnect', (req, res) => {
  setRequestOperation(req, 'contexts.disconnect');
  if (!req.userSession) throw badRequest('Session not found');
  req.userSession.activeContext = null;
  req.userSession.activeContextSource = null;
  res.json({ active: undefined });
}));

contextsRouter.post('/reload', withRouteErrorLogging('contexts', 'POST /reload', async (req, res) => {
  setRequestOperation(req, 'contexts.reload');
  if (!req.userSession) throw badRequest('Session not found');
  contextsService.invalidateCache(req.userSession.userId);
  res.json(
    await contextsService.getCachedPayload(
      req.userSession.userId,
      () => contextsPayload(req),
      () => contextsPayload(req, { skipConnectivity: true }),
      (err) => {
        logWarn('contexts.cache.refresh_failed', {
          reqId: req.logRequestId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    ),
  );
}));

contextsRouter.post('/local-kubeconfigs', withRouteErrorLogging('contexts', 'POST /local-kubeconfigs', async (req, res) => {
  setRequestOperation(req, 'contexts.local_kubeconfigs.upsert');
  if (!req.userSession) throw badRequest('Session not found');
  const userKey = requireUserKey(req);
  const body = z.object({ name: z.string().min(1), content: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest('name and content are required');

  const name = body.data.name.trim();
  // Repair deprecated Azure flags from kubeconfig before storing, and inject AZURE_CONFIG_DIR
  const content = repairKubeconfigContent(body.data.content, req.userSession.localAzureConfigDir);

  const contexts = parseKubeconfigContexts(content);
  await upsertDesktopLocalKubeconfig(userKey, { name, content, contexts });

  contextsService.invalidateCache(req.userSession.userId);
  res.status(201).json(await contextsPayload(req, { skipConnectivity: true }));
}));

contextsRouter.post('/local-kubeconfigs/:id/connect', withRouteErrorLogging('contexts', 'POST /local-kubeconfigs/:id/connect', async (req, res) => {
  setRequestOperation(req, 'contexts.local_kubeconfigs.connect');
  if (!req.userSession) throw badRequest('Session not found');
  const userKey = requireUserKey(req);
  const body = z.object({ contextName: z.string().min(1).optional() }).safeParse(req.body ?? {});
  if (!body.success) throw badRequest('Invalid request body');

  const local = await findDesktopLocalKubeconfig(userKey, req.params.id);
  if (!local) throw notFound('Local kubeconfig not found');

  logInfo('contexts.connect.step', {
    reqId: req.logRequestId ?? null,
    step: 'write_kubeconfig',
    contextCount: local.contexts.length,
  });

  // Read-modify-write: take the lock across BOTH the read and the write, or a concurrent
  // writer's change is silently dropped by the merge.
  const localKubeconfigPath = req.userSession.localKubeconfigPath;
  await withFileLock(localKubeconfigPath, async () => {
    const existingContent = await fsp.readFile(localKubeconfigPath, 'utf8').catch(() => '');
    const mergedContent = mergeKubeconfigContent(existingContent, local.content);
    await writeFileAtomic(localKubeconfigPath, mergedContent);
  });
  kube.invalidateLoadConfigCache(req.userSession.localKubeconfigPath);

  logInfo('contexts.connect.step', {
    reqId: req.logRequestId ?? null,
    step: 'read_contexts',
  });

  const contexts = await kube.getContexts(req.userSession.localKubeconfigPath);
  const targetContext = body.data.contextName ?? contexts[0]?.name;
  req.userSession.activeContext = targetContext ?? null;
  req.userSession.activeContextSource = targetContext ? 'local' : null;
  if (targetContext) {
    setSessionContextSourceHint(req.userSession, targetContext, 'local');
  }

  // Local kubeconfigs should not inherit stale AKS source tags from a previous
  // imported context with the same name.
  await removeContextSourcesForNames(userKey, 'local', local.contexts);

  if (targetContext) {
    logInfo('contexts.connect.step', {
      reqId: req.logRequestId ?? null,
      step: 'validate_target_context',
      targetContext,
    });
    await kube.rawConfig(targetContext, {
      kubeconfigPath: req.userSession.localKubeconfigPath,
      fallbackContext: req.userSession.activeContext,
    });
  }

  logInfo('contexts.connect.step', {
    reqId: req.logRequestId ?? null,
    step: 'build_context_payload',
    totalContexts: contexts.length,
  });

  res.json(await contextsPayload(req, { skipConnectivity: true }));
}));

contextsRouter.delete('/local-kubeconfigs/:id', async (req, res) => {
  setRequestOperation(req, 'contexts.local_kubeconfigs.delete');
  if (!req.userSession) throw badRequest('Session not found');
  const userKey = requireUserKey(req);

  // Capture the file's context names before deleting so we can also evict any that
  // were connected into the live session kubeconfig — otherwise they linger as
  // active contexts even though the source file is gone.
  const local = await findDesktopLocalKubeconfig(userKey, req.params.id);
  await deleteDesktopLocalKubeconfig(userKey, req.params.id);

  if (local) {
    const names = new Set(local.contexts ?? []);
    const activeRemoved = !!req.userSession.activeContext && names.has(req.userSession.activeContext);
    await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, names);
    await removeContextsFromKubeconfigFile(req.userSession.awsKubeconfigPath, names);
    await removeContextSourcesForNames(userKey, 'local', names);
    if (activeRemoved) {
      req.userSession.activeContext = null;
      req.userSession.activeContextSource = null;
    }
  }

  contextsService.invalidateCache(req.userSession.userId);
  res.json(await contextsPayload(req, { skipConnectivity: true }));
});

/** Remove a single context from a stored local kubeconfig. */
contextsRouter.delete('/local-kubeconfigs/:id/contexts/:contextName', async (req, res) => {
  setRequestOperation(req, 'contexts.local_kubeconfigs.delete_context');
  if (!req.userSession) throw badRequest('Session not found');
  const userKey = requireUserKey(req);
  const contextName = req.params.contextName;

  const local = await findDesktopLocalKubeconfig(userKey, req.params.id);
  if (!local) throw notFound('Local kubeconfig not found');

  let doc: any;
  try {
    doc = yaml.load(local.content);
  } catch (err) {
    throw badRequest('Stored kubeconfig is invalid', (err as Error).message);
  }
  if (!doc || !Array.isArray(doc.contexts)) throw badRequest('Kubeconfig has no contexts');

  const remaining = doc.contexts.filter((c: any) => c?.name !== contextName);
  if (remaining.length === doc.contexts.length) throw notFound(`Context "${contextName}" not found`);

  const activeRemoved = req.userSession.activeContext === contextName;

  // Also evict the context from the live session kubeconfig if it was connected,
  // so it disappears from the active contexts list (not just the stored file).
  await removeContextsFromKubeconfigFile(req.userSession.cloudKubeconfigPath, new Set([contextName]));
  await removeContextsFromKubeconfigFile(req.userSession.awsKubeconfigPath, new Set([contextName]));
  await removeContextSourcesForNames(userKey, 'local', [contextName]);

  if (remaining.length === 0) {
    // Last context removed — drop the whole kubeconfig.
    await deleteDesktopLocalKubeconfig(userKey, req.params.id);
    if (activeRemoved) {
      req.userSession.activeContext = null;
      req.userSession.activeContextSource = null;
    }
    contextsService.invalidateCache(req.userSession.userId);
    res.json(await contextsPayload(req, { skipConnectivity: true }));
    return;
  }

  doc.contexts = remaining;
  if (doc['current-context'] === contextName) {
    doc['current-context'] = remaining[0]?.name;
  }
  const newContent = yaml.dump(doc);
  const contexts = parseKubeconfigContexts(newContent);

  await replaceDesktopLocalKubeconfigContexts(userKey, req.params.id, newContent, contexts);

  if (activeRemoved) {
    req.userSession.activeContext = null;
    req.userSession.activeContextSource = null;
  }

  contextsService.invalidateCache(req.userSession.userId);
  res.json(await contextsPayload(req, { skipConnectivity: true }));
});
