type StartPayload = {
  context?: string;
  namespace?: string;
  plural: string;
  email?: string;
};

type InboundMessage =
  | { type: 'start'; payload: StartPayload }
  | { type: 'stop' };

type OutboundMessage =
  | { type: 'state'; state: 'connecting' | 'live' | 'disconnected' }
  | { type: 'event'; eventType: string; object: any }
  | { type: 'resync' }
  | { type: 'error'; message: string };

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let activePayload: StartPayload | null = null;
let disposed = false;
let reconnectAttempts = 0;
let currentConnectionOpened = false;
let hadFatalError = false;
let lastResourceVersion: string | undefined;
let pendingStopTimer: number | null = null;

// Give up only after this many *failed-to-open* attempts (5s apart) — i.e. the
// cluster is unreachable. A connection that opened and later closed (a normal
// k8s watch expiry on a healthy cluster) reconnects promptly and does not count
// toward this cap, so live updates keep flowing while the cluster is connected.
// A fresh 'start' message (user-initiated retry) resets the counter.
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 1500;
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
  search.set('plural', payload.plural);
  if (lastResourceVersion) search.set('resourceVersion', lastResourceVersion);
  return `${proto}://${self.location.host}/ws/watch?${search.toString()}`;
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
  hadFatalError = false;
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
      if (payload?.type === 'RESET') {
        lastResourceVersion = undefined;
        post({ type: 'resync' });
        return;
      }
      if (payload?.type === 'ERROR') {
        hadFatalError = true;
        post({ type: 'state', state: 'disconnected' });
        post({ type: 'error', message: payload.message ?? 'Watch error' });
        return;
      }
      const rv = payload?.object?.metadata?.resourceVersion;
      if (typeof rv === 'string' && rv.length > 0) {
        lastResourceVersion = rv;
      }
      post({ type: 'event', eventType: payload?.type, object: payload?.object });
    } catch {
      post({ type: 'error', message: 'Invalid watch payload' });
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

    if (currentConnectionOpened && !hadFatalError) {
      // Healthy connection that ended (e.g. the k8s watch expired). The cluster
      // is reachable, so reconnect promptly without counting toward the cap.
      reconnectTimer = self.setTimeout(() => {
        connect();
      }, HEALTHY_RECONNECT_MS);
      return;
    }

    // Either the connection never opened (cluster unreachable) or the server sent
    // a fatal error (e.g. 403 Forbidden — RBAC will never allow this watch to
    // succeed). Back off and give up after the cap instead of retrying forever;
    // the main thread can restart us with a fresh 'start' (manual retry).
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
    // Shared-worker mode can emit stop+start during rapid tab/scope switches
    // (and React StrictMode effect replay). Delay teardown briefly so an
    // immediate follow-up start keeps the first socket alive.
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
    lastResourceVersion = undefined;
    activePayload = msg.payload;
    clearReconnect();
    cleanupSocket();
    connect();
  }
};
