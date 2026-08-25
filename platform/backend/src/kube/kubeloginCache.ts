import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { run } from '../util/run.js';
import { logInfo, logError, logWarn } from '../util/logger.js';

interface KubeloginCacheEntry {
  token: string;
  expiresAt: number;
  context: string;
}

const kubeloginFetchInflight = new Map<string, Promise<string | null>>();

function buildKubeloginFetchKey(
  azureConfigDir: string,
  kubeconfigPath: string,
  context: string,
): string {
  return `${azureConfigDir}::${kubeconfigPath}::${context}`;
}

function withAzureCliLoginMode(args: string[]): string[] {
  const normalized: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    if (lower === '--login' || lower === '-l') {
      i += 1; // Skip current login mode value.
      continue;
    }

    normalized.push(arg);
  }

  normalized.push('--login', 'azurecli');
  return normalized;
}

/**
 * Get cached kubelogin token for a context in this session.
 * Returns null if no valid cached token exists.
 */
export async function getCachedKubeloginToken(
  azureConfigDir: string,
  context: string,
): Promise<string | null> {
  const cacheFile = path.join(azureConfigDir, '.kube', `token`);
  try {
    if (!fs.existsSync(cacheFile)) {
      logInfo('kubelogin.cache.miss', { context, reason: 'file_not_found' });
      return null;
    }

    const content = await fsp.readFile(cacheFile, 'utf8');
    const entry = JSON.parse(content) as KubeloginCacheEntry;

    // Check if token is still valid (not expired)

    // expiresAt is a timestamp in milliseconds and we compare it with the current time in miliseconds
    const currentTimeMs = Date.now();
    if (!entry.expiresAt || entry.expiresAt < currentTimeMs) {
      logInfo('kubelogin.cache.expired', { context, expiresAt: entry.expiresAt });
      return null;
    }

    logInfo('kubelogin.cache.hit', { context, expiresAt: entry.expiresAt });
    return entry.token;
  } catch (err) {
    logError('kubelogin.cache.read_error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
  const fetchKey = buildKubeloginFetchKey(azureConfigDir, kubeconfigPath, context);
  const existing = kubeloginFetchInflight.get(fetchKey);
  if (existing) {
    logInfo('kubelogin.fetch.join_inflight', { context });
    return existing;
  }

  const fetchPromise = fetchAndCacheKubeloginTokenInternal(
    azureConfigDir,
    kubeconfigPath,
    context,
  );
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
    const execArgs = withAzureCliLoginMode(rawExecArgs);
    logInfo('kubelogin.fetch.exec_config', {
      context,
      hasExecConfig: !!execConfig,
      rawArgsCount: rawExecArgs.length,
      argsCount: execArgs.length,
      execConfigKeys: execConfig ? Object.keys(execConfig as any) : [],
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
      logInfo('kubelogin.fetch.token_extracted', { context, hasToken: !!token, expiresIn });

      if (!token) {
        logError('kubelogin.fetch.no_token', {
          context,
        });
        return null;
      }

      // Cache the token with a 1-hour expiry
      const cacheFile = path.join(azureConfigDir, '.kube', `token`);
      const entry: KubeloginCacheEntry = {
        token,
        expiresAt: Date.parse(expiresIn), // Convert expirationTimestamp to a timestamp in milliseconds
        context,
      };

      logInfo('kubelogin.fetch.write_cache_start', { cacheFile });
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(entry, null, 2));
      logInfo('kubelogin.fetch.write_cache_complete', { cacheFile, expiresAt: entry.expiresAt });

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
