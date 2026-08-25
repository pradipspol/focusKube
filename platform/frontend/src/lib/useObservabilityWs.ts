import { useEffect, useMemo, useRef, useState } from 'react';
import { wsUrl } from '../api/client';

interface SubscriptionMessage {
  type: 'subscribe' | 'unsubscribe' | 'state-at';
  context?: string;
  timestamp?: string;
}

interface EventMessage {
  type: 'event' | 'state' | 'status' | 'error';
  data?: any;
  error?: string;
}

type MessageHandler = (message: EventMessage) => void;

type ContextSocketClient = {
  context: string;
  ws: WebSocket | null;
  handlers: Set<MessageHandler>;
  refCount: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  pendingMessages: SubscriptionMessage[];
  reconnectAttempt: number;
  shouldReconnect: boolean;
  connect: () => void;
  disconnect: () => void;
  send: (message: SubscriptionMessage) => void;
  snapshot: () => { readyState: number };
};

const clientsByContext = new Map<string, ContextSocketClient>();
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

function createClient(context: string): ContextSocketClient {
  const client: ContextSocketClient = {
    context,
    ws: null,
    handlers: new Set(),
    refCount: 0,
    reconnectTimer: null,
    disconnectTimer: null,
    pendingMessages: [],
    reconnectAttempt: 0,
    shouldReconnect: false,
    connect: () => {
      const current = client.ws;
      if (
        current?.readyState === WebSocket.OPEN ||
        current?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }

      try {
        const url = wsUrl('/ws/observability', { context });
        console.log('[ObservabilityWs] Connecting to', { context, url });
        const ws = new WebSocket(url);

        ws.onopen = () => {
          client.reconnectAttempt = 0;
          console.log('[ObservabilityWs] Connected to', context);
          const pending = client.pendingMessages.splice(0);
          pending.forEach((message) => ws.send(JSON.stringify(message)));
        };

        ws.onmessage = (event) => {
          try {
            const raw = typeof event.data === 'string' ? event.data : String(event.data);
            const message = JSON.parse(raw) as EventMessage;
            client.handlers.forEach((handler) => handler(message));
          } catch (err) {
            console.error('[ObservabilityWs] Parse error:', err);
          }
        };

        ws.onerror = (event) => {
          console.error('[ObservabilityWs] Error:', event);
        };

        ws.onclose = (event) => {
          console.log(
            '[ObservabilityWs] Disconnected from',
            context,
            'code=',
            event.code,
            'reason=',
            event.reason || '(none)',
          );
          client.ws = null;
          if (client.shouldReconnect && client.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            client.reconnectAttempt += 1;
            const delay = RECONNECT_DELAY_MS * Math.pow(2, client.reconnectAttempt - 1);
            client.reconnectTimer = setTimeout(() => {
              client.connect();
            }, delay);
          }
        };

        client.ws = ws;
      } catch (err) {
        console.error('[ObservabilityWs] Connection error:', err);
      }
    },
    disconnect: () => {
      client.shouldReconnect = false;
      if (client.reconnectTimer) {
        clearTimeout(client.reconnectTimer);
        client.reconnectTimer = null;
      }
      if (client.ws) {
        client.ws.close();
        client.ws = null;
      }
      client.pendingMessages = [];
    },
    send: (message: SubscriptionMessage) => {
      if (!client.ws || client.ws.readyState !== WebSocket.OPEN) {
        if (client.shouldReconnect) {
          client.pendingMessages.push(message);
          client.connect();
          return;
        }
        console.warn('[ObservabilityWs] Not connected, cannot send message', message.type);
        return;
      }
      client.ws.send(JSON.stringify(message));
    },
    snapshot: () => ({
      readyState: client.ws?.readyState ?? WebSocket.CLOSED,
    }),
  };

  return client;
}

function acquireClient(context: string): ContextSocketClient {
  let client = clientsByContext.get(context);
  if (!client) {
    client = createClient(context);
    clientsByContext.set(context, client);
  }
  client.refCount += 1;
  client.shouldReconnect = true;
  if (client.disconnectTimer) {
    clearTimeout(client.disconnectTimer);
    client.disconnectTimer = null;
  }
  client.connect();
  return client;
}

function releaseClient(client: ContextSocketClient): void {
  client.refCount = Math.max(0, client.refCount - 1);
  if (client.refCount > 0) return;
  // React Strict Mode briefly releases and reacquires effects during its
  // development probe. Keep the connecting socket alive across that cycle.
  client.disconnectTimer = setTimeout(() => {
    client.disconnectTimer = null;
    if (client.refCount === 0) {
      client.disconnect();
      clientsByContext.delete(client.context);
    }
  }, 100);
}

export function useObservabilityWs(context?: string) {
  const clientRef = useRef<ContextSocketClient | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);

  useEffect(() => {
    if (!context) {
      if (clientRef.current) {
        releaseClient(clientRef.current);
        clientRef.current = null;
      }
      setReadyState(WebSocket.CLOSED);
      return;
    }

    const client = acquireClient(context);
    clientRef.current = client;
    setReadyState(client.snapshot().readyState);

    const interval = setInterval(() => {
      setReadyState(client.snapshot().readyState);
    }, 500);

    return () => {
      clearInterval(interval);
      if (clientRef.current) {
        releaseClient(clientRef.current);
        clientRef.current = null;
      }
    };
  }, [context]);

  const subscribe = useMemo(
    () =>
      (handler: MessageHandler) => {
        const client = clientRef.current;
        if (!client) {
          return () => {};
        }
        client.handlers.add(handler);
        return () => {
          client.handlers.delete(handler);
        };
      },
    [],
  );

  const requestStateAt = useMemo(
    () =>
      (timestamp: Date) => {
        const client = clientRef.current;
        if (!client) {
          console.warn('[ObservabilityWs] No client, cannot request state-at');
          return;
        }
        client.send({
          type: 'state-at',
          timestamp: timestamp.toISOString(),
        });
      },
    [],
  );

  return {
    ws: clientRef.current?.ws ?? null,
    isConnected: readyState === WebSocket.OPEN,
    subscribe,
    requestStateAt,
  };
}
