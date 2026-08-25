import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

export const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  kubeconfigPath: process.env.KUBECONFIG || undefined,
  allowSecretReveal: (process.env.ALLOW_SECRET_REVEAL ?? 'false') === 'true',
  sessionStorageDir: process.env.SESSION_STORAGE_DIR ?? path.join(os.tmpdir(), 'focusKube', 'sessions'),
  azureConfigSeedDir: process.env.AZURE_CONFIG_SEED_DIR || undefined,
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS ?? '168', 10),
  slowRequestWarnMs: parseInt(process.env.SLOW_REQUEST_WARN_MS ?? '5000', 10),
  slowCommandWarnMs: parseInt(process.env.SLOW_COMMAND_WARN_MS ?? '5000', 10),
  slowK8sWarnMs: parseInt(process.env.SLOW_K8S_WARN_MS ?? '10000', 10),
  k8sApiTimeoutMs: parseInt(process.env.K8S_API_TIMEOUT_MS ?? '12000', 10),
  k8sListTimeoutMs: parseInt(process.env.K8S_LIST_TIMEOUT_MS ?? '12000', 10),
  k8sContextProbeTimeoutMs: parseInt(process.env.K8S_CONTEXT_PROBE_TIMEOUT_MS ?? '5000', 10),
  azureAuthCheckTimeoutMs: parseInt(process.env.AZURE_AUTH_CHECK_TIMEOUT_MS ?? '5000', 10),
  azureAuthCheckCacheMs: parseInt(process.env.AZURE_AUTH_CHECK_CACHE_MS ?? '15000', 10),
  // A failed/timed-out probe is cached for far less time than a successful one:
  // a cold `az account show` spawn racing another az/kubelogin process can
  // time out once even though the user is signed in, and we don't want that
  // single false negative gating every panel for the full positive-cache window.
  azureAuthCheckNegativeCacheMs: parseInt(process.env.AZURE_AUTH_CHECK_NEGATIVE_CACHE_MS ?? '2000', 10),
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS ?? '5', 10),

  // Base URL of the frontend app, used for post-login/redirect targets.
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  // Default local identity used for the desktop session when no email header is sent.
  defaultAdminEmail: (process.env.DEFAULT_ADMIN_EMAIL ?? 'user@desktop.com').trim().toLowerCase(),
};
