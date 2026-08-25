import { kube } from './client.js';
import { hasAzureCliLogin } from '../azure/azure.js';
import { logInfo } from '../util/logger.js';
import { HttpError } from '../util/httpError.js';
import type { SessionScope } from '../auth/session.js';
import { repairKubeconfig } from './kubeConfigRepair.js';
import { fetchAndCacheKubeloginToken, getCachedKubeloginToken } from './kubeloginCache.js';

interface EnsureContextAuthOptions {
  context?: string;
  kubeconfigPath?: string;
  fallbackContext?: string | null;
  azureConfigDir?: string;
  source?: SessionScope;
  userId?: string;
  azureLogin?: any; // Not used in simplified auth, but kept for backward compat
}

/**
 * Simplified auth check for Kubernetes contexts.
 * 
 * For now, this just ensures the kubeconfig can be loaded.
 * We don't do kubelogin token caching because it was causing indefinite hangs.
 * Let Kubernetes and kubelogin handle auth passthrough directly when needed.
 */
export async function ensureContextAuthReady(options: EnsureContextAuthOptions): Promise<void> {
  const startTime = Date.now();
  const context = options.context ?? 'default';

  logInfo('kube.auth.start', { context, userId: options.userId ?? null });

  // Normalize kubeconfig auth exec args early (devicecode -> azurecli), so
  // all API/WS code paths avoid interactive kubelogin hangs.
  if (options.kubeconfigPath) {
    const changed = await repairKubeconfig(options.kubeconfigPath, options.azureConfigDir);
    if (changed) {
      kube.invalidateLoadConfigCache(options.kubeconfigPath);
    }
  }

  // Warm the Azure exec-token cache before any watch/client object is built.
  // This avoids the first watch request falling through to a cold Azure CLI
  // credential path and surfacing a misleading az login error.
  // Only attempt this once the user has actually signed in to Azure - otherwise
  // every call before sign-in spawns a doomed kubelogin attempt (and its temp
  // kubeconfig file) that can never succeed.
  if (options.kubeconfigPath && options.azureConfigDir && options.userId) {
    try {
      const cachedToken = await getCachedKubeloginToken(options.azureConfigDir, context);
      if (!cachedToken && (await hasAzureCliLogin(options.azureConfigDir))) {
        await fetchAndCacheKubeloginToken(
          options.azureConfigDir,
          options.kubeconfigPath,
          context,
        );
      }
    } catch (err) {
      logInfo('kube.auth.kubelogin_prefetch_failed', {
        context,
        userId: options.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Load and validate the kubeconfig can be accessed
  logInfo('kube.auth.rawconfig.start', { context, elapsed: Date.now() - startTime });
  const kc = await kube.rawConfig(options.context, {
    kubeconfigPath: options.kubeconfigPath,
    fallbackContext: options.fallbackContext,
  });
  logInfo('kube.auth.rawconfig.complete', { context, elapsed: Date.now() - startTime });

  const user = kc.getCurrentUser();
  const userAny = user as any;

  // Check if user has local credentials (token, tokenFile, certificate, username, password)
  // These don't require external auth like Azure CLI or kubelogin
  const hasLocalCredentials =
    userAny?.token ||
    userAny?.tokenFile ||
    userAny?.clientCertificate ||
    userAny?.clientKey ||
    (userAny?.username && userAny?.password);

  if (hasLocalCredentials) {
    logInfo('kube.auth.has_local_credentials', {
      context,
      hasToken: !!userAny?.token,
      hasTokenFile: !!userAny?.tokenFile,
      hasCertificate: !!userAny?.clientCertificate,
      hasKey: !!userAny?.clientKey,
      hasBasicAuth: !!(userAny?.username && userAny?.password),
      elapsed: Date.now() - startTime,
    });
    return;
  }

  const exec = userAny?.exec ?? userAny?.authProvider?.config?.exec ?? userAny?.authProvider?.exec;
  if (!exec) {
    logInfo('kube.auth.no_exec_required', { context, elapsed: Date.now() - startTime });
    return;
  }

  // For kubelogin and other exec auth, let it pass through
  // The Kubernetes client will handle executing the auth command as needed
  const command = String(exec.command ?? '').toLowerCase();

  // If the context relies on Azure exec auth, require an Azure CLI login in the
  // currently selected config directory (cloud vs local isolation).
  if (command.includes('kubelogin') || command.includes('az')) {
    const azureConfigDir = options.azureConfigDir?.trim();
    if (azureConfigDir) {
      const cachedToken = await getCachedKubeloginToken(azureConfigDir, context);
      if (cachedToken) {
        logInfo('kube.auth.cached_token_available', {
          context,
          elapsed: Date.now() - startTime,
        });
        return;
      }

      const isLoggedIn = await hasAzureCliLogin(azureConfigDir);
      if (!isLoggedIn) {
        throw new HttpError(
          401,
          'Azure authentication is required for this context. Please sign in from the Azure panel.',
          { code: 'AZURE_AUTH_REQUIRED', source: options.source ?? 'cloud' },
        );
      }
    }
  }

  logInfo('kube.auth.exec_auth_passthrough', {
    context,
    command,
    elapsed: Date.now() - startTime,
  });
  return;
}
