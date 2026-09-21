import * as k8s from '@kubernetes/client-node';
import { Writable } from 'node:stream';
import { kube } from './client.js';
import { getResource, listResource, matchesDeploymentSelector, type KubeAccessOptions } from './resources.js';

// Matches the general tool-output cap the AI assistant applies before re-sending anything
// into the model's context (see aiToolExecutor.ts) — logs are the output most likely to be huge.
const MAX_LOG_BYTES = 8 * 1024;
const LOG_FETCH_TIMEOUT_MS = 15_000;
const MAX_PODS_PER_DEPLOYMENT = 3;

export interface LogFetchResult {
  text: string;
  truncated: boolean;
}

/** Accumulates raw Buffer chunks (not per-chunk string decoding, which would corrupt any
 * multi-byte UTF-8 character split across a chunk boundary) and decodes once, at the end, so
 * the cap is an accurate byte count rather than a JS string length. */
function boundedWritable(capBytes: number): {
  stream: Writable;
  getText: () => string;
  wasTruncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (!truncated) {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (total + buf.length > capBytes) {
          chunks.push(buf.subarray(0, capBytes - total));
          total = capBytes;
          truncated = true;
        } else {
          chunks.push(buf);
          total += buf.length;
        }
      }
      cb();
    },
  });
  return { stream, getText: () => Buffer.concat(chunks).toString('utf8'), wasTruncated: () => truncated };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetches one pod's logs as a plain string (no follow). @kubernetes/client-node's `Log.log()`
 * is built to stream into a long-lived Writable (see ws/streams.ts's handleLogs/
 * handleDeploymentLogs, which pipe straight into a WebSocket) and never resolves with the full
 * text itself, for the AI assistant's get_logs tool.
 *
 * Deliberately does NOT use Log.log()'s done-callback overload: passing a callback makes the
 * underlying `request` library additionally buffer the ENTIRE response body internally (its
 * own callback-style contract), on top of piping it into `stream` — defeating MAX_LOG_BYTES
 * for a large/unbounded log before the cap ever gets a chance to apply. Completion is instead
 * signaled by the stream's own 'finish' event (fired once `req.pipe(stream)` ends), and the
 * live request is aborted directly on timeout so a slow/hung fetch doesn't leak the socket. */
export async function fetchPodLogsOnce(
  namespace: string,
  podName: string,
  container: string | undefined,
  opts: { tailLines: number; context?: string; kubeOptions: KubeAccessOptions },
): Promise<LogFetchResult> {
  const kubeConfig = await kube.rawConfig(opts.context, opts.kubeOptions);
  const log = new k8s.Log(kubeConfig);
  const { stream, getText, wasTruncated } = boundedWritable(MAX_LOG_BYTES);

  const donePromise = new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  let request: { abort: () => void } | undefined;
  try {
    request = (await log.log(namespace, podName, container ?? '', stream, {
      follow: false,
      tailLines: opts.tailLines,
      pretty: false,
    })) as unknown as { abort: () => void };
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  try {
    await withTimeout(donePromise, LOG_FETCH_TIMEOUT_MS, `Timed out fetching logs for pod ${podName}`);
  } catch (err) {
    request.abort();
    throw err;
  }

  return { text: getText(), truncated: wasTruncated() };
}

/** Fetches logs for a Deployment's pods (up to MAX_PODS_PER_DEPLOYMENT), one section per pod —
 * the same pod-selector matching handleDeploymentLogs uses, but resolving to a single string
 * instead of streaming. */
export async function fetchDeploymentLogsOnce(
  namespace: string,
  deploymentName: string,
  container: string | undefined,
  opts: { tailLines: number; context?: string; kubeOptions: KubeAccessOptions },
): Promise<LogFetchResult> {
  const deployment: any = await getResource('deployments', deploymentName, opts.context, namespace, opts.kubeOptions);
  const selector = deployment?.spec?.selector ?? {};
  // matchesDeploymentSelector's checks both vacuously pass for an empty selector, which would
  // otherwise match every pod in the namespace under this deployment's name — refuse instead
  // of silently returning unrelated pods' logs for a malformed/degraded manifest.
  const hasSelector =
    (selector.matchLabels && Object.keys(selector.matchLabels).length > 0) ||
    (Array.isArray(selector.matchExpressions) && selector.matchExpressions.length > 0);
  if (!hasSelector) {
    return { text: `Deployment "${deploymentName}" has no usable pod selector.`, truncated: false };
  }
  const pods: any[] = await listResource('pods', opts.context, namespace, opts.kubeOptions);
  const matching = (Array.isArray(pods) ? pods : []).filter((pod) =>
    matchesDeploymentSelector(selector, pod.metadata?.labels ?? {}),
  );

  if (matching.length === 0) {
    return { text: `No pods matched deployment "${deploymentName}"'s selector.`, truncated: false };
  }

  const chosen = matching.slice(0, MAX_PODS_PER_DEPLOYMENT);
  const sections = await Promise.all(
    chosen.map(async (pod) => {
      const podName = pod.metadata?.name;
      try {
        const { text, truncated } = await fetchPodLogsOnce(namespace, podName, container, opts);
        return `--- pod/${podName} ---\n${text}${truncated ? '\n… (truncated)' : ''}`;
      } catch (err) {
        return `--- pod/${podName} ---\n[error fetching logs: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }),
  );

  return { text: sections.join('\n\n'), truncated: matching.length > chosen.length };
}
