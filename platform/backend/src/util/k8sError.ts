import { HttpError } from './httpError.js';
import { config } from '../config.js';
import { logWarn, logError } from './logger.js';
import { clearTenantPinIfGuessed, getCachedKubeloginToken, getContextPin, invalidateKubeloginToken } from '../kube/kubeloginCache.js';

interface K8sCallMeta {
  action?: string;
  plural?: string;
  context?: string;
  namespace?: string;
  name?: string;
  /** Present when this context authenticates via a cached Azure/kubelogin token. */
  azureConfigDir?: string;
}

interface K8sCallOptions {
  timeoutMs?: number;
}

/**
 * Normalize errors thrown by @kubernetes/client-node into HttpErrors with a
 * meaningful status code and message. Handles both the fetch-based ApiException
 * (newer) and the request-based error shape (older).
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;

  const anyErr = err as any;

  // Newer client: ApiException { code, body }
  const rawStatus =
    anyErr?.code ?? anyErr?.statusCode ?? anyErr?.response?.statusCode;
  let status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);

  let body = anyErr?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep string */
    }
  }

  const message: string =
    body?.message ??
    anyErr?.response?.body?.message ??
    anyErr?.message ??
    'Kubernetes API error';

  if (!Number.isFinite(status) || status < 400 || status > 599) status = 500;
  return new HttpError(status, message, body?.reason);
}

/** Run a k8s client call and rethrow normalized errors. */
export async function callK8s<T>(fn: () => Promise<T>, meta: K8sCallMeta = {}, options: K8sCallOptions = {}): Promise<T> {
  const startedHr = process.hrtime.bigint();
  const timeoutMs = options.timeoutMs ?? config.k8sApiTimeoutMs;
  try {
    const promise = fn();
    const result = await withTimeout(
      promise,
      timeoutMs,
      new HttpError(504, `Kubernetes API call timed out after ${timeoutMs}ms`),
    );
    const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
    if (elapsedMs >= config.slowK8sWarnMs) {
      logWarn('k8s.call.slow', {
        ...meta,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        thresholdMs: config.slowK8sWarnMs,
      });
    }
    return result;
  } catch (err: any) {
    const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
    if (err instanceof HttpError && err.status === 504) {
      logError('k8s.call.timeout', {
        ...meta,
        timeoutMs,
        elapsedMs: Number(elapsedMs.toFixed(1)),
      });
    }
    logError('k8s.call.error', {
      ...meta,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      error: err instanceof Error ? err.message : String(err),
      // errorDescription: JSON.stringify(err),
      // errorMsg: err?.response?.message || "No message"
    });
    const httpErr = toHttpError(err);
    if (httpErr.status === 401 && meta.azureConfigDir) {
      throw await onUnauthorizedFromApiServer(httpErr, meta.azureConfigDir, meta.context);
    }
    throw httpErr;
  }
}

/**
 * The API server itself (not our own auth guard) rejected the request as
 * Unauthorized. Every session (even purely local, non-Azure contexts) carries
 * an azureConfigDir, so first confirm this context actually authenticated via
 * a cached kubelogin/Azure token before assuming that's the cause - a local
 * kubeconfig with a revoked static token/certificate should keep its original
 * error, not get told to sign into Azure.
 *
 * When it is Azure-backed: the token we applied - freshly fetched or from
 * cache - is not valid for this cluster (commonly: the signed-in Azure
 * account/tenant does not match the one this cluster trusts). Drop the
 * cached token so the next attempt fetches a new one instead of reusing the
 * same rejected token for up to an hour, and surface a message that points
 * at the actual cause instead of a bare "Unauthorized".
 */
async function onUnauthorizedFromApiServer(
  original: HttpError,
  azureConfigDir: string,
  context?: string,
): Promise<HttpError> {
  if (!context) return original;

  const pin = await getContextPin(azureConfigDir, context);
  if (!pin.tenantId || !pin.serverId) return original;

  let staleToken: string | null = null;
  try {
    staleToken = await getCachedKubeloginToken(azureConfigDir, pin.tenantId, pin.serverId);
  } catch {
    // Diagnostics only - a failure here must not mask the original error.
  }
  if (!staleToken) return original;

  // Shared by every context in this tenant using this server app - dropping
  // it affects all of them, which is correct: a token rejected for this
  // context is the exact same bearer token the others would also be sending.
  await invalidateKubeloginToken(azureConfigDir, pin.tenantId, pin.serverId);
  // If this context's tenant was only ever a guess (learned from whichever
  // tenant the ambient Azure CLI default happened to be), let it be wrong and
  // self-correct on the next attempt instead of staying stuck reusing the
  // same bad tenant forever. A ground-truth pin (from subscription import)
  // is left alone - the retry logs below still show what tenant was tried.
  await clearTenantPinIfGuessed(azureConfigDir, context);
  logWarn('k8s.call.unauthorized_token_invalidated', {
    context,
    tenantId: pin.tenantId,
    serverId: pin.serverId,
    azureConfigDir,
  });

  return new HttpError(
    401,
    'Kubernetes rejected the request as Unauthorized. This usually means the Azure account currently signed in does not have access to this cluster (wrong tenant/subscription, or the sign-in has changed since credentials were imported). Sign out and back in to Azure with the correct account, then retry.',
    { code: 'AZURE_TOKEN_REJECTED', context, tenantId: pin.tenantId, originalMessage: original.message },
  );
}

/**
 * Same 401-detection/invalidation as callK8s, for call sites that don't go
 * through it - the WebSocket handlers (logs/exec/watch/metrics) talk to the
 * k8s client directly rather than via callK8s, but should still drop a
 * rejected cached token and surface the clearer message instead of leaving
 * WS clients with a bare "Unauthorized" and a token that just keeps getting
 * reused on every reconnect/poll until it expires.
 */
export async function describeK8sError(
  err: unknown,
  meta: { azureConfigDir?: string; context?: string } = {},
): Promise<string> {
  const httpErr = toHttpError(err);
  if (httpErr.status === 401 && meta.azureConfigDir) {
    const enriched = await onUnauthorizedFromApiServer(httpErr, meta.azureConfigDir, meta.context);
    return enriched.message;
  }
  return httpErr.message;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const raceResult = await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    return raceResult;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
