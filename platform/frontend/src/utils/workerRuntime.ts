function watchWorkerUrl(): URL {
  if (import.meta.env.DEV) {
    return new URL('../workers/watch.worker.ts', import.meta.url);
  }
  return new URL('/workers/watch.worker.js', window.location.origin);
}

function metricsWorkerUrl(): URL {
  if (import.meta.env.DEV) {
    return new URL('../workers/metrics.worker.ts', import.meta.url);
  }
  return new URL('/workers/metrics.worker.js', window.location.origin);
}

let watchWorkerSingleton: Worker | null = null;
let metricsWorkerSingleton: Worker | null = null;
const watchWorkers = new Map<string, Worker>();

export function getWatchWorker(key: string = 'default'): Worker {
  const existing = watchWorkers.get(key);
  if (existing) return existing;
  const created = new Worker(watchWorkerUrl(), { type: 'module' });
  watchWorkers.set(key, created);
  return created;
}

export function releaseWatchWorker(key: string = 'default'): void {
  const existing = watchWorkers.get(key);
  if (!existing) return;
  try {
    existing.terminate();
  } catch {
    // ignore terminate failures
  }
  watchWorkers.delete(key);
}

export function getMetricsWorker(): Worker {
  if (!metricsWorkerSingleton) {
    metricsWorkerSingleton = new Worker(metricsWorkerUrl(), { type: 'module' });
  }
  return metricsWorkerSingleton;
}

export function preloadWorkers(): void {
  // Preload worker modules at app boot so later features reuse warm workers.
  getMetricsWorker();
}
