import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { run } from '../util/run.js';
import { logInfo, logError, logWarn } from '../util/logger.js';

interface SharedTokenEntry {
  token: string;
  expiresAt: number;
}

/**
 * Keyed by "${tenantId}::${serverId}". A token is scoped to an Azure AD
 * tenant's identity and the AKS server app it was issued for - not to any one
 * cluster. Every context in the same tenant using the same server app
 * (virtually all of them, since it's normally the shared first-party AKS
 * server app id) shares one cached token instead of each cluster fetching
 * and storing its own copy of what is functionally the same credential.
 */
type SharedTokenFile = Record<string, SharedTokenEntry>;

interface ContextPin {
  tenantId?: string;
  /**
   * 'ground-truth' = pinned at AKS-credential-import time from the actually
   * selected subscription's tenantId (verified Azure metadata) - never
   * auto-cleared by a failed request. 'reactive' = merely inferred from
   * whatever tenant a kubelogin fetch happened to use (the ambient Azure CLI
   * default at the time) - if that turns out to be wrong, a 401 clears it so
   * the context can self-correct instead of being stuck on a bad guess.
   */
  tenantSource?: 'ground-truth' | 'reactive';
  serverId?: string;
}

/**
 * Keyed by context name. Sticky per-context facts - which tenant and server
 * app a context's credentials resolve to - used to look up the shared token
 * cache above without re-parsing the kubeconfig on every request.
 */
type ContextPinFile = Record<string, ContextPin>;

const kubeloginFetchInflight = new Map<string, Promise<string | null>>();

function tokensFilePath(azureConfigDir: string): string {
  return path.join(azureConfigDir, '.kube', 'tokens.json');
}

function pinsFilePath(azureConfigDir: string): string {
  return path.join(azureConfigDir, '.kube', 'context-pins.json');
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
}

function tokenKey(tenantId: string, serverId: string): string {
  return `${tenantId}::${serverId}`;
}

/**
 * Pull the AAD tenant id (`tid` claim) out of a JWT without verifying its
 * signature. Diagnostic only - lets logs show which Azure tenant a token
 * belongs to so a "wrong account signed in" mismatch is visible without an
 * extra `az account show` round-trip.
 */
export function decodeJwtTenantId(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return typeof claims?.tid === 'string' ? claims.tid : undefined;
  } catch {
    return undefined;
  }
}

/** Pull `--server-id <value>` out of a kubeconfig exec plugin's args array. */
export function extractServerId(execArgs: unknown): string | undefined {
  if (!Array.isArray(execArgs)) return undefined;
  for (let i = 0; i < execArgs.length; i++) {
    if (String(execArgs[i]).toLowerCase() === '--server-id') {
      const value = execArgs[i + 1];
      return value !== undefined ? String(value) : undefined;
    }
  }
  return undefined;
}

/**
 * Pull `--tenant-id <value>` out of a kubeconfig exec plugin's args array.
 * `az aks get-credentials` / `kubelogin convert-kubeconfig` bake the tenant a
 * cluster actually belongs to directly into the file at generation time -
 * ground truth for that specific cluster, and for contexts that came from an
 * already-existing/local kubeconfig (never routed through our own
 * subscription-import flow) it's the only ground truth available at all.
 */
export function extractTenantId(execArgs: unknown): string | undefined {
  if (!Array.isArray(execArgs)) return undefined;
  for (let i = 0; i < execArgs.length; i++) {
    const lower = String(execArgs[i]).toLowerCase();
    if (lower === '--tenant-id' || lower === '-t') {
      const value = execArgs[i + 1];
      return value !== undefined ? String(value) : undefined;
    }
  }
  return undefined;
}

/**
 * Force azurecli login mode (never prompt interactively) and, when we know
 * which tenant previously worked for this context, pin the fetch to that
 * tenant explicitly via --tenant-id. Without the pin, azurecli mode just asks
 * whatever Azure CLI identity is currently active in this config dir for a
 * token - which can silently be a different tenant than the one this
 * specific cluster trusts, especially right after switching contexts.
 *
 * Only strips an existing --tenant-id from the original args when we're
 * actually overriding it with a known-better value. If the caller doesn't
 * know a tenant, whatever --tenant-id the kubeconfig already had (baked in
 * at generation time) must survive untouched - dropping it silently falls
 * back to azurecli's ambient default identity, which is frequently the wrong
 * tenant for this specific cluster.
 */
function withAzureCliAuthArgs(args: string[], tenantId?: string): string[] {
  const normalized: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    if (lower === '--login' || lower === '-l') {
      i += 1; // Skip current login mode value.
      continue;
    }
    if (tenantId && (lower === '--tenant-id' || lower === '-t')) {
      i += 1; // Skip current tenant value - we're overriding it below.
      continue;
    }

    normalized.push(arg);
  }

  normalized.push('--login', 'azurecli');
  if (tenantId) normalized.push('--tenant-id', tenantId);
  return normalized;
}

/** Read a context's own pin (tenant id / server id last recorded for it). */
export async function getContextPin(azureConfigDir: string, context: string): Promise<ContextPin> {
  const pins = await readJsonFile<ContextPinFile>(pinsFilePath(azureConfigDir), {});
  return pins[context] ?? {};
}

async function updateContextPin(azureConfigDir: string, context: string, patch: ContextPin): Promise<void> {
  try {
    const pins = await readJsonFile<ContextPinFile>(pinsFilePath(azureConfigDir), {});
    pins[context] = { ...pins[context], ...patch };
    await writeJsonFile(pinsFilePath(azureConfigDir), pins);
  } catch (err) {
    logWarn('kubelogin.pin.write_failed', {
      context,
      azureConfigDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Pin a context to the tenant its Azure subscription actually belongs to,
 * known at AKS-credential-import time straight from `az account list`
 * (ground truth), rather than waiting to infer it reactively from whatever
 * tenant a first, possibly-wrong-ambient-default kubelogin fetch happens to
 * produce. This is verified Azure metadata, not a guess - a later 401 will
 * never auto-clear it.
 */
export async function pinTenantId(azureConfigDir: string, context: string, tenantId: string): Promise<void> {
  await updateContextPin(azureConfigDir, context, { tenantId, tenantSource: 'ground-truth' });
  logInfo('kubelogin.cache.tenant_pinned', { context, tenantId, azureConfigDir });
}

/**
 * Record a tenant a context happened to authenticate with when nothing had
 * pinned it yet - this is a guess (whatever the ambient Azure CLI default
 * was at fetch time), not verified, so it never overwrites an existing
 * ground-truth pin and a later 401 is allowed to clear it again.
 */
async function learnTenantIdReactively(azureConfigDir: string, context: string, tenantId: string): Promise<void> {
  const current = await getContextPin(azureConfigDir, context);
  if (current.tenantSource === 'ground-truth') return;
  await updateContextPin(azureConfigDir, context, { tenantId, tenantSource: 'reactive' });
  logInfo('kubelogin.cache.tenant_learned_reactively', { context, tenantId, azureConfigDir });
}

/**
 * Clear a context's tenant pin so the next fetch re-derives it, instead of
 * being permanently stuck reusing a tenant that just got a token rejected.
 * Refuses to touch a ground-truth pin - that's verified Azure metadata, so a
 * 401 for it means something else is wrong (revoked RBAC, etc.), not a bad
 * tenant guess.
 */
export async function clearTenantPinIfGuessed(azureConfigDir: string, context: string): Promise<void> {
  const current = await getContextPin(azureConfigDir, context);
  if (!current.tenantId || current.tenantSource === 'ground-truth') return;
  await updateContextPin(azureConfigDir, context, { tenantId: undefined, tenantSource: undefined });
  logInfo('kubelogin.pin.tenant_cleared', { context, azureConfigDir, previousTenantId: current.tenantId });
}

/** Record which AKS server app a context's exec plugin targets, once known. */
export async function recordContextServerId(azureConfigDir: string, context: string, serverId: string): Promise<void> {
  const current = await getContextPin(azureConfigDir, context);
  if (current.serverId === serverId) return;
  await updateContextPin(azureConfigDir, context, { serverId });
}

/**
 * Get the cached token for a tenant + server-id pair - the actual scope a
 * token is valid for - not for any one cluster. Every context in that tenant
 * using that server app shares this entry. Returns null if no valid cached
 * token exists.
 */
export async function getCachedKubeloginToken(
  azureConfigDir: string,
  tenantId: string,
  serverId: string,
): Promise<string | null> {
  const tokens = await readJsonFile<SharedTokenFile>(tokensFilePath(azureConfigDir), {});
  const entry = tokens[tokenKey(tenantId, serverId)];
  if (!entry?.token) {
    logInfo('kubelogin.cache.miss', { tenantId, serverId, reason: 'no_entry' });
    return null;
  }

  // expiresAt is a timestamp in milliseconds and we compare it with the current time in miliseconds
  const currentTimeMs = Date.now();
  if (!entry.expiresAt || entry.expiresAt < currentTimeMs) {
    logInfo('kubelogin.cache.expired', { tenantId, serverId, expiresAt: entry.expiresAt });
    return null;
  }

  logInfo('kubelogin.cache.hit', { tenantId, serverId, expiresAt: entry.expiresAt });
  return entry.token;
}

async function cacheKubeloginToken(
  azureConfigDir: string,
  tenantId: string,
  serverId: string,
  token: string,
  expiresAt: number,
): Promise<void> {
  const tokens = await readJsonFile<SharedTokenFile>(tokensFilePath(azureConfigDir), {});
  tokens[tokenKey(tenantId, serverId)] = { token, expiresAt };
  await writeJsonFile(tokensFilePath(azureConfigDir), tokens);
}

/**
 * Drop the cached token for one tenant + server-id pair so the next auth
 * attempt fetches a fresh one instead of reusing a token the Kubernetes API
 * server already rejected. Since the token is shared, this affects every
 * context in that tenant using that server app - which is correct: a token
 * rejected for one of them is the exact same bearer token every other one
 * would also be (re)sending.
 */
export async function invalidateKubeloginToken(azureConfigDir: string, tenantId: string, serverId: string): Promise<void> {
  try {
    const tokens = await readJsonFile<SharedTokenFile>(tokensFilePath(azureConfigDir), {});
    const key = tokenKey(tenantId, serverId);
    if (!(key in tokens)) return;
    delete tokens[key];
    await writeJsonFile(tokensFilePath(azureConfigDir), tokens);
    logInfo('kubelogin.cache.invalidated', { tenantId, serverId, azureConfigDir });
  } catch (err) {
    logWarn('kubelogin.cache.invalidate_failed', {
      tenantId,
      serverId,
      azureConfigDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read a context's exec plugin args straight from a kubeconfig file, without invoking kubelogin. */
async function readContextExecArgs(kubeconfigPath: string, context: string): Promise<unknown> {
  try {
    const kc = new k8s.KubeConfig();
    const content = await fsp.readFile(kubeconfigPath, 'utf8');
    kc.loadFromString(content);
    const ctx = kc.contexts.find((c) => c.name === context);
    const user = ctx?.user ? kc.users.find((u) => u.name === ctx.user) : undefined;
    return (user as any)?.exec?.args;
  } catch {
    return undefined;
  }
}

/**
 * Resolve which tenant/server-id a context's credentials actually belong to,
 * consulting the sticky pin first and falling back to a cheap kubeconfig
 * parse (no kubelogin invocation) when the server-id hasn't been learned yet,
 * or when the tenant isn't pinned as ground truth yet - the kubeconfig's own
 * exec args may already embed the real tenant (see extractTenantId), which
 * for contexts that never go through subscription-import pinning (any
 * local/pre-existing kubeconfig) is the only ground truth this context will
 * ever get.
 */
export async function resolveContextIdentity(
  azureConfigDir: string,
  context: string,
  kubeconfigPath?: string,
): Promise<ContextPin> {
  let pin = await getContextPin(azureConfigDir, context);
  const needsServerId = !pin.serverId;
  const needsTenantId = pin.tenantSource !== 'ground-truth';
  if ((!needsServerId && !needsTenantId) || !kubeconfigPath) return pin;

  const execArgs = await readContextExecArgs(kubeconfigPath, context);

  if (needsServerId) {
    const serverId = extractServerId(execArgs);
    if (serverId) {
      await recordContextServerId(azureConfigDir, context, serverId);
      pin = { ...pin, serverId };
    }
  }

  if (needsTenantId) {
    const embeddedTenantId = extractTenantId(execArgs);
    if (embeddedTenantId) {
      await pinTenantId(azureConfigDir, context, embeddedTenantId);
      pin = { ...pin, tenantId: embeddedTenantId, tenantSource: 'ground-truth' };
    }
  }

  return pin;
}

/**
 * Fetch kubelogin token using kubelogin command and cache it.
 * This is called after Azure login is complete to refresh the token.
 */
export async function fetchAndCacheKubeloginToken(
  azureConfigDir: string,
  kubeconfigPath: string,
  context: string,
): Promise<string | null> {
  const pin = await resolveContextIdentity(azureConfigDir, context, kubeconfigPath);
  // Once identity (tenant+server-id) is known, this also joins concurrent
  // fetches across *different* contexts that share it - not just the same
  // context - so opening several clusters in one tenant at once doesn't
  // spawn a kubelogin process per cluster.
  const fetchKey =
    pin.tenantId && pin.serverId
      ? `${azureConfigDir}::${pin.tenantId}::${pin.serverId}`
      : `${azureConfigDir}::context::${context}`;
  const existing = kubeloginFetchInflight.get(fetchKey);
  if (existing) {
    logInfo('kubelogin.fetch.join_inflight', { context, fetchKey });
    return existing;
  }

  const fetchPromise = fetchAndCacheKubeloginTokenInternal(azureConfigDir, kubeconfigPath, context, pin.tenantId);
  kubeloginFetchInflight.set(fetchKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    kubeloginFetchInflight.delete(fetchKey);
  }
}

async function fetchAndCacheKubeloginTokenInternal(
  azureConfigDir: string,
  kubeconfigPath: string,
  context: string,
  knownTenantId: string | undefined,
): Promise<string | null> {
  try {
    logInfo('kubelogin.fetch.start', { context, kubeconfigPath, azureConfigDir });

    // Load original kubeconfig to extract exec args
    logInfo('kubelogin.fetch.load_original_config', { kubeconfigPath });
    const kcOriginal = new k8s.KubeConfig();
    const originalContent = await fsp.readFile(kubeconfigPath, 'utf8');
    kcOriginal.loadFromString(originalContent);

    const ctxOriginal = kcOriginal.contexts.find((c) => c.name === context);
    logInfo('kubelogin.fetch.context_lookup', {
      context,
      foundContext: !!ctxOriginal,
      contextUserName: ctxOriginal?.user ?? null,
      availableContexts: kcOriginal.contexts.map((c) => c.name),
    });

    const userOriginal = ctxOriginal?.user ? kcOriginal.users.find((u) => u.name === ctxOriginal.user) : undefined;
    logInfo('kubelogin.fetch.user_lookup', {
      context,
      searchingFor: ctxOriginal?.user ?? null,
      foundUser: !!userOriginal,
      availableUsers: kcOriginal.users.map((u) => u.name),
      userStructure: userOriginal ? Object.keys((userOriginal as any)) : [],
    });

    const execConfig = userOriginal?.exec;
    const rawExecArgs = Array.isArray(execConfig?.args)
      ? execConfig.args.map((arg: any) => String(arg))
      : ['get-token'];
    const serverId = extractServerId(rawExecArgs);
    if (serverId) await recordContextServerId(azureConfigDir, context, serverId);

    const execArgs = withAzureCliAuthArgs(rawExecArgs, knownTenantId);
    logInfo('kubelogin.fetch.exec_config', {
      context,
      hasExecConfig: !!execConfig,
      rawArgsCount: rawExecArgs.length,
      argsCount: execArgs.length,
      execConfigKeys: execConfig ? Object.keys(execConfig as any) : [],
      pinnedTenantId: knownTenantId ?? null,
      serverId: serverId ?? null,
    });

    // Ensure the Azure config directory exists so the cache can live beside
    // the existing Azure CLI session files.
    await fsp.mkdir(azureConfigDir, { recursive: true });
    logInfo('kubelogin.fetch.cache_dir_ready', { azureConfigDir });

    // Create a temp kubeconfig for kubelogin to update
    const tempConfigPath = path.join(
      azureConfigDir,
      `kubeconfig-${context}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-temp`,
    );
    logInfo('kubelogin.fetch.copy_start', { from: kubeconfigPath, to: tempConfigPath });
    await fsp.copyFile(kubeconfigPath, tempConfigPath);
    logInfo('kubelogin.fetch.copy_complete', { tempConfigPath });

    try {
      // Run kubelogin to update the kubeconfig with the token
      logInfo('kubelogin.fetch.exec_start', { context, tempConfigPath, args: execArgs });
      const result = await run('kubelogin', execArgs, {
        env: {
          KUBECONFIG: tempConfigPath,
          AZURE_CONFIG_DIR: azureConfigDir,
        },
        timeoutMs: 30_000, // 30 second timeout for kubelogin
      });

      logInfo('kubelogin.fetch.exec_complete', {
        context,
        code: result.code,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
      });

      if (result.code !== 0) {
        logError('kubelogin.fetch.exec_failed', {
          context,
          code: result.code,
          stderr: result.stderr.slice(0, 500), // First 500 chars
          stdout: result.stdout.slice(0, 500),
        });
        return null;
      }

      // write token to temp tempConfigPath file
      const response = result.stdout.toString().trim();
      const js = JSON.parse(response); // Ensure it's valid JSON
      const token = js?.status?.token;
      const expiresIn = js?.status?.expirationTimestamp;
      const tenantId = token ? decodeJwtTenantId(token) : undefined;
      logInfo('kubelogin.fetch.token_extracted', { context, hasToken: !!token, expiresIn, tenantId: tenantId ?? null });

      if (!token) {
        logError('kubelogin.fetch.no_token', {
          context,
        });
        return null;
      }

      if (tenantId) await learnTenantIdReactively(azureConfigDir, context, tenantId);

      const expiresAt = Date.parse(expiresIn);
      if (tenantId && serverId) {
        await cacheKubeloginToken(azureConfigDir, tenantId, serverId, token, expiresAt);
        logInfo('kubelogin.fetch.write_cache_complete', { context, tenantId, serverId, expiresAt });
      } else {
        logWarn('kubelogin.fetch.not_cached', {
          context,
          tenantId: tenantId ?? null,
          serverId: serverId ?? null,
          reason: 'missing tenantId or serverId - token returned for this call only, not shared',
        });
      }

      logInfo('kubelogin.fetch.success', { context });
      return token;
    } finally {
      // Always clean up the temp config, regardless of how the attempt ended,
      // so failed/timed-out kubelogin runs don't leak files into azureConfigDir.
      try {
        await fsp.unlink(tempConfigPath);
        logInfo('kubelogin.fetch.cleanup_complete', { tempConfigPath });
      } catch (cleanupErr) {
        logError('kubelogin.fetch.cleanup_failed', { tempConfigPath, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
      }
    }
  } catch (err) {
    logError('kubelogin.fetch.error', {
      context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
    });
    return null;
  }
}
