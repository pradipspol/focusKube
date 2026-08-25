import { HttpError } from './httpError.js';
import { config } from '../config.js';
import { logWarn, logError } from './logger.js';

interface K8sCallMeta {
  action?: string;
  plural?: string;
  context?: string;
  namespace?: string;
  name?: string;
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
    throw toHttpError(err);
  }
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
