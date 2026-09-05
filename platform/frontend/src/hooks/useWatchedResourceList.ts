import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, getDesktopEmail, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { getWatchWorker, releaseWatchWorker } from '../utils/workerRuntime';

type ResourceListResult = { items: K8sObject[] };

type WatchWorkerInbound =
  | { type: 'start'; payload: { context?: string; namespace?: string; plural: string; email?: string } }
  | { type: 'stop' };

type WatchWorkerOutbound =
  | { type: 'state'; state: 'connecting' | 'live' | 'disconnected' }
  | { type: 'event'; eventType: string; object: K8sObject }
  | { type: 'resync' }
  | { type: 'error'; message: string };

const RESYNC_THROTTLE_MS = 5000;

function objectIdentity(object: K8sObject): string | undefined {
  const uid = object.metadata?.uid;
  if (uid) return uid;
  const name = object.metadata?.name;
  if (!name) return undefined;
  return `${object.metadata?.namespace ?? ''}/${name}`;
}

function applyWatchEventToCache(
  qc: QueryClient,
  queryKey: Array<string | undefined>,
  eventType: string,
  object: K8sObject,
) {
  qc.setQueryData<ResourceListResult | undefined>(queryKey, (current) => {
    if (!current) return current;
    const key = objectIdentity(object);
    if (!key) return current;

    if (eventType === 'DELETED') {
      return { items: current.items.filter((item) => objectIdentity(item) !== key) };
    }
    if (eventType !== 'ADDED' && eventType !== 'MODIFIED') {
      return current;
    }

    const index = current.items.findIndex((item) => objectIdentity(item) === key);
    if (index === -1) {
      return { items: [object, ...current.items] };
    }
    const nextItems = current.items.slice();
    nextItems[index] = object;
    return { items: nextItems };
  });
}

/**
 * Lists a resource once and keeps it fresh via the same watch-worker websocket
 * ResourceTable uses, instead of polling with a repeating GET. Callers that
 * don't need live updates (e.g. a closed panel) should pass `enabled: false`.
 */
export function useWatchedResourceList(watchKeyPrefix: string, plural: string, scope: Scope, enabled: boolean) {
  const qc = useQueryClient();
  const queryKey = ['resource', plural, scope.context, scope.namespace, ''];

  const query = useQuery<ResourceListResult>({
    queryKey,
    queryFn: () => api.listResource(plural, scope),
    enabled: enabled && !!scope.context,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const lastResyncAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || !scope.context) return;

    const watchKey = `${watchKeyPrefix}:${plural}:${scope.context}:${scope.namespace ?? ''}`;
    const worker = getWatchWorker(watchKey);

    const onMessage = (event: MessageEvent<WatchWorkerOutbound>) => {
      const payload = event.data;
      if (!payload) return;
      if (payload.type === 'resync') {
        const now = Date.now();
        if (now - lastResyncAtRef.current < RESYNC_THROTTLE_MS) return;
        lastResyncAtRef.current = now;
        void qc.invalidateQueries({ queryKey });
        return;
      }
      if (payload.type === 'event' && payload.object) {
        applyWatchEventToCache(qc, queryKey, payload.eventType, payload.object);
      }
    };
    worker.addEventListener('message', onMessage as EventListener);

    const startMsg: WatchWorkerInbound = {
      type: 'start',
      payload: { email: getDesktopEmail(), context: scope.context, namespace: scope.namespace, plural },
    };
    worker.postMessage(startMsg);

    return () => {
      worker.postMessage({ type: 'stop' } satisfies WatchWorkerInbound);
      worker.removeEventListener('message', onMessage as EventListener);
      releaseWatchWorker(watchKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, plural, qc, scope.context, scope.namespace, watchKeyPrefix]);

  return query;
}
