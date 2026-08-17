import { Router } from 'express';
import { getChangeEventStore } from '../observability/store.js';
import { RecordingLifecycle } from '../observability/lifecycle.js';
import { correlateEvents } from '../observability/correlate.js';
import { activeSessionKubeconfigPath, activeSessionAzureConfigDir, resolveSessionScopeForContext } from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { badRequest, notFound } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import { logInfo, logError } from '../util/logger.js';
import { withRouteErrorLogging } from '../util/httpError.js';

export const observabilityRouter = Router();

let lifecycle: RecordingLifecycle | null = null;

function initLifecycle(): RecordingLifecycle {
  if (!lifecycle) {
    lifecycle = new RecordingLifecycle(getChangeEventStore());
  }
  return lifecycle;
}

function isObservabilityAvailable(): boolean {
  return true;
}

// GET /api/observability/status — check availability (never throws)
observabilityRouter.get('/status', withRouteErrorLogging('observability', 'GET /status', async (req, res) => {
  setRequestOperation(req, 'observability.status');

  const available = isObservabilityAvailable();

  if (!available) {
    return res.json({
      available: false,
      reason: 'desktop-mode',
      recording: null,
    });
  }

  try {
    const context = req.query.context as string | undefined;
    const userId = req.authUser?.id;
    const lifecycle_ = initLifecycle();
    const status = await lifecycle_.getStatus(context, userId);

    res.json({
      available: true,
      recording: status,
    });
  } catch (err) {
    logError('observability.status_query_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({
      available: true,
      recording: null,
    });
  }
}));

// POST /api/observability/recordings/start
observabilityRouter.post('/recordings/start', withRouteErrorLogging('observability', 'POST /recordings/start', async (req, res) => {
  setRequestOperation(req, 'observability.recordings.start');

  if (!isObservabilityAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const { context } = req.body || {};
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const userId = req.authUser?.id;

  if (!context) throw badRequest('context is required');
  if (!userId) throw badRequest('user not authenticated');

  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      userId,
    });

    const lifecycle_ = initLifecycle();
    const result = await lifecycle_.startRecording(context, userId, kubeconfigPath, session.activeContext ?? undefined);

    res.json(result);
  } catch (err) {
    logError('observability.recording.start_failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}));

// POST /api/observability/recordings/stop
observabilityRouter.post('/recordings/stop', withRouteErrorLogging('observability', 'POST /recordings/stop', async (req, res) => {
  setRequestOperation(req, 'observability.recordings.stop');

  if (!isObservabilityAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const { context, serverUrl } = req.body || {};
  const userId = req.authUser?.id;

  if (!context) throw badRequest('context is required');
  if (!userId) throw badRequest('user not authenticated');

  try {
    const lifecycle_ = initLifecycle();
    await lifecycle_.stopRecording(context, userId, serverUrl);
    res.json({ status: 'stopped', context, userId });
  } catch (err) {
    logError('observability.recording.stop_failed', {
      context,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}));

// GET /api/observability/events
observabilityRouter.get('/events', withRouteErrorLogging('observability', 'GET /events', async (req, res) => {
  setRequestOperation(req, 'observability.events');

  if (!isObservabilityAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const context = req.query.context as string | undefined;
  const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = req.query.to ? new Date(req.query.to as string) : new Date();

  if (!context) throw badRequest('context is required');

  try {
    const store = getChangeEventStore();
    const events = await store.queryEvents(context, from, to, {
      namespace: req.query.namespace as string | undefined,
      category: req.query.category as string | undefined,
      severity: req.query.severity as string | undefined,
    });

    res.json(events);
  } catch (err) {
    logError('observability.events_query_failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}));

// GET /api/observability/state-at
observabilityRouter.get('/state-at', withRouteErrorLogging('observability', 'GET /state-at', async (req, res) => {
  setRequestOperation(req, 'observability.state_at');

  if (!isObservabilityAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const context = req.query.context as string | undefined;
  const timestamp = req.query.timestamp ? new Date(req.query.timestamp as string) : new Date();

  if (!context) throw badRequest('context is required');

  try {
    const store = getChangeEventStore();
    const state = await store.queryStateAt(context, timestamp, req.query.namespace as string | undefined);

    res.json(state);
  } catch (err) {
    logError('observability.state_at_query_failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}));

// GET /api/observability/correlation
observabilityRouter.get('/correlation', withRouteErrorLogging('observability', 'GET /correlation', async (req, res) => {
  setRequestOperation(req, 'observability.correlation');

  if (!isObservabilityAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const context = req.query.context as string | undefined;
  const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = req.query.to ? new Date(req.query.to as string) : new Date();

  if (!context) throw badRequest('context is required');

  try {
    const store = getChangeEventStore();
    const events = await store.queryEvents(context, from, to);
    const correlated = correlateEvents(events);

    res.json(correlated);
  } catch (err) {
    logError('observability.correlation_query_failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}));

export function getRecordingLifecycle(): RecordingLifecycle | null {
  return lifecycle;
}
