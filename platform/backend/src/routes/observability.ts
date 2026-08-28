import { Router } from 'express';
import { badRequest } from '../util/httpError.js';
import { setRequestOperation } from '../util/requestOp.js';
import { logInfo, logError } from '../util/logger.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import { observabilityService } from '../services/observabilityService.js';
import { ensureScopedContextAuth, resolveScopedRequestContext } from './requestContext.js';
import type { RecordingLifecycle } from '../observability/lifecycle.js';

export const observabilityRouter = Router();

// GET /api/observability/debug/recordings — list all active recordings (debug only)
observabilityRouter.get('/debug/recordings', withRouteErrorLogging('observability', 'GET /debug/recordings', async (req, res) => {
  setRequestOperation(req, 'observability.debug.recordings');

  try {
    const lifecycle = observabilityService.getLifecycleInstance();
    if (!lifecycle) {
      return res.json({ error: 'No lifecycle instance' });
    }

    // Access the internal recordings collection via getter if available
    // For now, return available status
    res.json({
      message: 'Check backend logs for: observability.recording.started, observability.recording.scope_mode, observability.informer.event_*',
    });
  } catch (err) {
    logError('observability.debug.recordings_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to get recordings' });
  }
}));

// GET /api/observability/status — check availability (never throws)
observabilityRouter.get('/status', withRouteErrorLogging('observability', 'GET /status', async (req, res) => {
  setRequestOperation(req, 'observability.status');

  const available = observabilityService.isAvailable();

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
    const status = await observabilityService.getStatus(context, userId);

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

  if (!observabilityService.isAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const { context } = req.body || {};
  const session = req.userSession;
  const userId = req.authUser?.id;

  if (!context) throw badRequest('context is required');
  if (!userId) throw badRequest('user not authenticated');

  try {
    const scoped = await resolveScopedRequestContext(req, { context });
    logInfo('observability.recording.auth_scope_resolved', {
      context,
      selectedScope: scoped.selectedScope,
      kubeconfigPath: scoped.selectedKubeconfigPath,
    });
    await ensureScopedContextAuth(req, scoped);
    logInfo('observability.recording.auth_complete', { context, userId });

    const result = await observabilityService.startRecording(
      context,
      userId,
      scoped.selectedKubeconfigPath,
      session.activeContext ?? undefined,
      scoped.selectedAzureConfigDir,
    );
    logInfo('observability.recording.start_complete', { context, userId, recordingId: result.recordingId });

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

  if (!observabilityService.isAvailable()) {
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
    await observabilityService.stopRecording(context, userId, serverUrl);
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

  if (!observabilityService.isAvailable()) {
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
    const events = await observabilityService.queryEvents(context, from, to, {
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

  if (!observabilityService.isAvailable()) {
    return res.status(503).json({
      error: 'OBSERVABILITY_UNAVAILABLE',
      reason: 'desktop-mode',
    });
  }

  const context = req.query.context as string | undefined;
  const timestamp = req.query.timestamp ? new Date(req.query.timestamp as string) : new Date();

  if (!context) throw badRequest('context is required');

  try {
    const state = await observabilityService.queryStateAt(context, timestamp, req.query.namespace as string | undefined);

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

  if (!observabilityService.isAvailable()) {
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
    const correlated = await observabilityService.correlate(context, from, to);

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
  return observabilityService.getLifecycleInstance();
}
