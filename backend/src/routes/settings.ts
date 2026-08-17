import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../util/httpError.js';
import { getEnvLogLevel, getLogLevel, hasUiLogLevelOverride, setLogLevel } from '../util/logger.js';
import type { LogLevel } from '../util/logger.types.js';
import { setRequestOperation } from '../util/requestOp.js';
import { withRouteErrorLogging } from '../util/httpError.js';

export const settingsRouter = Router();

const levelSchema = z.enum(['debug', 'info', 'warn', 'error']);

settingsRouter.get('/log-level', withRouteErrorLogging('settings', 'GET /log-level', (req, res) => {
  setRequestOperation(req, 'settings.log_level.get');
  res.json({
    level: getLogLevel(),
    envLevel: getEnvLogLevel(),
    overriddenByUi: hasUiLogLevelOverride(),
    editable: true,
    mode: 'desktop',
  });
}));

settingsRouter.post('/log-level', withRouteErrorLogging('settings', 'POST /log-level', (req, res) => {
  setRequestOperation(req, 'settings.log_level.set');

  const parsed = z.object({ level: levelSchema }).safeParse(req.body);
  if (!parsed.success) {
    throw badRequest('A valid log level is required.');
  }

  const level = setLogLevel(parsed.data.level as LogLevel);
  res.json({
    ok: true,
    level,
  });
}));
