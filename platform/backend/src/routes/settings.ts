import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../util/httpError.js';
import { getEnvLogLevel, getLogLevel, hasUiLogLevelOverride, setLogLevel } from '../util/logger.js';
import type { LogLevel } from '../util/logger.types.js';
import { setRequestOperation } from '../util/requestOp.js';
import { withRouteErrorLogging } from '../util/httpError.js';
import {
  loadAppSettings,
  mcpSettingsSchema,
  networkSettingsSchema,
  regenerateMcpToken,
  telemetrySettingsSchema,
  updateAppSettings,
  type AppSettings,
} from '../runtime/appSettingsStore.js';
import { applyNetworkSettings, validateNetworkSettings } from '../network/networkSettings.js';
import { clearUsageStats, getUsageStats, setUsageTrackingEnabled } from '../runtime/usageStats.js';
import { applyMcpSettings, getMcpServerStatus } from '../mcp/mcpServer.js';

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

function settingsResponse(settings: AppSettings) {
  return {
    network: settings.network,
    telemetry: settings.telemetry,
    mcp: { ...settings.mcp, status: getMcpServerStatus() },
  };
}

settingsRouter.get('/app', withRouteErrorLogging('settings', 'GET /app', async (req, res) => {
  setRequestOperation(req, 'settings.app.get');
  res.json(settingsResponse(await loadAppSettings()));
}));

const appSettingsPatchSchema = z.object({
  network: networkSettingsSchema.optional(),
  telemetry: telemetrySettingsSchema.optional(),
  mcp: mcpSettingsSchema.optional(),
});

settingsRouter.put('/app', withRouteErrorLogging('settings', 'PUT /app', async (req, res) => {
  setRequestOperation(req, 'settings.app.update');
  const parsed = appSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings.');
  }
  if (parsed.data.network) validateNetworkSettings(parsed.data.network);

  const settings = await updateAppSettings(parsed.data);
  if (parsed.data.network) applyNetworkSettings(settings.network);
  if (parsed.data.telemetry) await setUsageTrackingEnabled(settings.telemetry.usageTracking);
  if (parsed.data.mcp) await applyMcpSettings(settings.mcp);
  res.json(settingsResponse(settings));
}));

settingsRouter.post('/app/mcp/token', withRouteErrorLogging('settings', 'POST /app/mcp/token', async (req, res) => {
  setRequestOperation(req, 'settings.mcp.regenerate_token');
  res.json(settingsResponse(await regenerateMcpToken()));
}));

settingsRouter.get('/usage', withRouteErrorLogging('settings', 'GET /usage', async (req, res) => {
  setRequestOperation(req, 'settings.usage.get');
  res.json(await getUsageStats());
}));

settingsRouter.delete('/usage', withRouteErrorLogging('settings', 'DELETE /usage', async (req, res) => {
  setRequestOperation(req, 'settings.usage.clear');
  await clearUsageStats();
  res.json({ ok: true });
}));
