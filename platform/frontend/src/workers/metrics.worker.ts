type StartPayload = {
  context?: string;
  namespace?: string;
  pod: string;
  email?: string;
};

type InboundMessage =
  | { type: 'start'; payload: StartPayload }
  | { type: 'stop' };

type OutboundMessage =
  | { type: 'state'; state: 'connecting' | 'live' | 'disconnected' }
  | { type: 'metrics'; data: any }
  | { type: 'error'; message: string };

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let activePayload: StartPayload | null = null;
let disposed = false;
let reconnectAttempts = 0;
let currentConnectionOpened = false;
let pendingStopTimer: number | null = null;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 5000;
const HEALTHY_RECONNECT_MS = 1000;
const STOP_DEBOUNCE_MS = 250;

function post(msg: OutboundMessage) {
  self.postMessage(msg);
}

function clearReconnect() {
  if (reconnectTimer !== null) {
    self.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearPendingStop() {
  if (pendingStopTimer !== null) {
    self.clearTimeout(pendingStopTimer);
    pendingStopTimer = null;
  }
}

function wsUrl(payload: StartPayload): string {
  const proto = self.location.protocol === 'https:' ? 'wss' : 'ws';
  const search = new URLSearchParams();
  if (payload.email) search.set('email', payload.email);
  if (payload.context) search.set('context', payload.context);
  if (payload.namespace) search.set('namespace', payload.namespace);
  search.set('pod', payload.pod);
  return `${proto}://${self.location.host}/ws/metrics?${search.toString()}`;
}

function cleanupSocket() {
  try {
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
}

function connect() {
  if (disposed || !activePayload) return;
  currentConnectionOpened = false;
  post({ type: 'state', state: 'connecting' });
  socket = new WebSocket(wsUrl(activePayload));

  socket.onopen = () => {
    currentConnectionOpened = true;
    reconnectAttempts = 0;
    post({ type: 'state', state: 'live' });
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data));
      if (payload?.type === 'ERROR') {
        post({ type: 'state', state: 'disconnected' });
        post({ type: 'error', message: payload.message ?? 'Metrics error' });
        return;
      }
      if (payload?.type === 'METRICS') {
        post({ type: 'metrics', data: payload });
        return;
      }
    } catch {
      post({ type: 'error', message: 'Invalid metrics payload' });
    }
  };

  socket.onerror = () => {
    post({ type: 'state', state: 'disconnected' });
    cleanupSocket();
  };

  socket.onclose = () => {
    post({ type: 'state', state: 'disconnected' });
    cleanupSocket();
    if (disposed) return;
    clearReconnect();

    if (currentConnectionOpened) {
      reconnectTimer = self.setTimeout(() => {
        connect();
      }, HEALTHY_RECONNECT_MS);
      return;
    }

    reconnectAttempts += 1;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      post({ type: 'error', message: `Stopped reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.` });
      return;
    }
    reconnectTimer = self.setTimeout(() => {
      connect();
    }, RECONNECT_INTERVAL_MS);
  };
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'stop') {
    clearPendingStop();
    pendingStopTimer = self.setTimeout(() => {
      pendingStopTimer = null;
      disposed = true;
      clearReconnect();
      cleanupSocket();
    }, STOP_DEBOUNCE_MS);
    return;
  }

  if (msg.type === 'start') {
    clearPendingStop();
    disposed = false;
    reconnectAttempts = 0;
    activePayload = msg.payload;
    clearReconnect();
    cleanupSocket();
    connect();
  }
};
