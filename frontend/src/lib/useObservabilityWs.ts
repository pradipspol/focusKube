import { useEffect, useRef, useCallback } from 'react';

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

export function useObservabilityWs(context?: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY_MS = 2000;

  const connect = useCallback(() => {
    if (!context || wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/observability?context=${encodeURIComponent(context)}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        console.log('[ObservabilityWs] Connected to', context);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as EventMessage;
          handlersRef.current.forEach(handler => handler(message));
        } catch (err) {
          console.error('[ObservabilityWs] Parse error:', err);
        }
      };

      ws.onerror = (event) => {
        console.error('[ObservabilityWs] Error:', event);
      };

      ws.onclose = () => {
        console.log('[ObservabilityWs] Disconnected from', context);
        wsRef.current = null;
        // Attempt reconnect
        if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptRef.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptRef.current - 1));
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('[ObservabilityWs] Connection error:', err);
    }
  }, [context]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const requestStateAt = useCallback((timestamp: Date) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[ObservabilityWs] Not connected, cannot request state-at');
      return;
    }

    const message: SubscriptionMessage = {
      type: 'state-at',
      timestamp: timestamp.toISOString(),
    };

    wsRef.current.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (context) {
      connect();
    }
    return () => {
      disconnect();
    };
  }, [context, connect, disconnect]);

  return {
    ws: wsRef.current,
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
    subscribe,
    requestStateAt,
  };
}
