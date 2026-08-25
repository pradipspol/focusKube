import { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { getChangeEventStore } from '../observability/store.js';
import { getRecordingLifecycle } from '../routes/observability.js';
import { logInfo, logError } from '../util/logger.js';

export const observabilityWss = new WebSocketServer({ noServer: true });

interface SubscriptionMessage {
  type: 'subscribe' | 'unsubscribe' | 'state-at';
  context?: string;
  timestamp?: string; // ISO8601 for state-at requests
}

interface EventMessage {
  type: 'event' | 'state' | 'status' | 'error';
  data?: any;
  error?: string;
}

/** Maintain active subscriptions by context */
const contextSubscriptions = new Map<string, Set<WebSocket>>();
/** Track connection IDs for logging */
const connectionIds = new Map<WebSocket, string>();
let nextConnectionId = 1;

/**
 * Start watching observability events for a context.
 * Pushes new events as they arrive in the database.
 */
function startEventWatch(context: string, ws: WebSocket): void {
  if (!contextSubscriptions.has(context)) {
    contextSubscriptions.set(context, new Set());
  }
  contextSubscriptions.get(context)!.add(ws);

  const connId = connectionIds.get(ws) || `conn-${nextConnectionId++}`;
  if (!connectionIds.has(ws)) {
    connectionIds.set(ws, connId);
  }

  logInfo('observability.ws.subscription_started', {
    context,
    connectionId: connId,
  });
}

function stopEventWatch(context: string, ws: WebSocket): void {
  const subs = contextSubscriptions.get(context);
  if (subs) {
    subs.delete(ws);
    if (subs.size === 0) {
      contextSubscriptions.delete(context);
    }
  }

  const connId = connectionIds.get(ws) || 'unknown';

  logInfo('observability.ws.subscription_stopped', {
    context,
    connectionId: connId,
  });

  connectionIds.delete(ws);
}

export function broadcastObservabilityEvent(context: string, event: any): void {
  const subs = contextSubscriptions.get(context);
  if (!subs || subs.size === 0) return;

  const message: EventMessage = {
    type: 'event',
    data: event,
  };

  const payload = JSON.stringify(message);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function broadcastRecordingStatus(context: string, status: any): void {
  const subs = contextSubscriptions.get(context);
  if (!subs || subs.size === 0) return;

  const message: EventMessage = {
    type: 'status',
    data: status,
  };

  const payload = JSON.stringify(message);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export async function handleObservabilityUpgrade(ws: WebSocket, req: any): Promise<void> {
  const url = new URL(req.url, 'http://localhost');
  const context = url.searchParams.get('context');

  if (!context) {
    logError('observability.ws.no_context', {
      url: req.url,
    });
    ws.send(JSON.stringify({
      type: 'error',
      error: 'context query parameter is required',
    }));
    ws.close(4000, 'Missing context parameter');
    return;
  }

  logInfo('observability.ws.upgrade', {
    context,
    userId: req.authUser?.id,
  });

  startEventWatch(context, ws);

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as SubscriptionMessage;

      if (message.type === 'state-at') {
        if (!message.timestamp) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'timestamp is required for state-at requests',
          }));
          return;
        }

        try {
          const store = getChangeEventStore();
          const state = await store.queryStateAt(
            context,
            new Date(message.timestamp),
            undefined,
          );

          ws.send(JSON.stringify({
            type: 'state',
            data: state,
          }));
        } catch (err) {
          logError('observability.ws.state_at_failed', {
            context,
            timestamp: message.timestamp,
            error: err instanceof Error ? err.message : String(err),
          });
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Failed to query state',
          }));
        }
      }
    } catch (err) {
      logError('observability.ws.message_parse_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format',
      }));
    }
  });

  ws.on('close', () => {
    stopEventWatch(context, ws);
  });

  ws.on('error', (err) => {
    logError('observability.ws.error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    stopEventWatch(context, ws);
  });

  // Send initial status
  try {
    const lifecycle = getRecordingLifecycle();
    const userId = req.authUser?.id;
    if (lifecycle) {
      const recordings = await lifecycle.getStatus(context, userId);
      ws.send(JSON.stringify({
        type: 'status',
        data: {
          available: true,
          recording: recordings,
        },
      }));
    }
  } catch (err) {
    logError('observability.ws.initial_status_failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
