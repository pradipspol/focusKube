import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { logError } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

const APP_SETTINGS_FILE = 'app-settings.json';

export const DEFAULT_MCP_PORT = 47821;

const proxyUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Proxy URL must be an http:// or https:// URL.');

export const networkSettingsSchema = z.object({
  proxyMode: z.enum(['environment', 'none', 'manual']),
  httpProxy: proxyUrlSchema,
  httpsProxy: proxyUrlSchema,
  noProxy: z.string().trim().max(4096),
  caCertPath: z.string().trim().max(1024),
  useSystemCa: z.boolean(),
});

export const telemetrySettingsSchema = z.object({
  usageTracking: z.boolean(),
});

export const mcpSettingsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  allowWrite: z.boolean(),
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;
export type TelemetrySettings = z.infer<typeof telemetrySettingsSchema>;
export type McpSettings = z.infer<typeof mcpSettingsSchema> & { token: string };

export interface AppSettings {
  network: NetworkSettings;
  telemetry: TelemetrySettings;
  mcp: McpSettings;
}

function generateMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

function defaultSettings(): AppSettings {
  return {
    network: {
      proxyMode: 'environment',
      httpProxy: '',
      httpsProxy: '',
      noProxy: 'localhost,127.0.0.1,::1',
      caCertPath: '',
      useSystemCa: false,
    },
    telemetry: { usageTracking: false },
    mcp: { enabled: false, port: DEFAULT_MCP_PORT, allowWrite: false, token: generateMcpToken() },
  };
}

let current: AppSettings | null = null;

function settingsPath(): string {
  return path.join(config.sessionStorageDir, APP_SETTINGS_FILE);
}

/** Merges a persisted (possibly partial/older) file over the defaults, dropping invalid sections. */
function normalize(raw: unknown): AppSettings {
  const defaults = defaultSettings();
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const network = networkSettingsSchema.safeParse({ ...defaults.network, ...data.network });
  const telemetry = telemetrySettingsSchema.safeParse({ ...defaults.telemetry, ...data.telemetry });
  const mcp = mcpSettingsSchema.safeParse({ ...defaults.mcp, ...data.mcp });
  const token = typeof data.mcp?.token === 'string' && data.mcp.token.length >= 32 ? data.mcp.token : defaults.mcp.token;
  return {
    network: network.success ? network.data : defaults.network,
    telemetry: telemetry.success ? telemetry.data : defaults.telemetry,
    mcp: { ...(mcp.success ? mcp.data : defaults.mcp), token },
  };
}

export async function loadAppSettings(): Promise<AppSettings> {
  if (current) return current;
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8');
    current = normalize(raw.trim() ? JSON.parse(raw) : {});
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      logError('app_settings.load_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    current = defaultSettings();
    await persist(current);
  }
  return current;
}

export function getAppSettings(): AppSettings {
  return current ?? defaultSettings();
}

async function persist(settings: AppSettings): Promise<void> {
  await withFileLock(settingsPath(), () => writeFileAtomic(settingsPath(), JSON.stringify(settings, null, 2)));
}

export async function updateAppSettings(patch: {
  network?: NetworkSettings;
  telemetry?: TelemetrySettings;
  mcp?: z.infer<typeof mcpSettingsSchema>;
}): Promise<AppSettings> {
  const base = await loadAppSettings();
  const next: AppSettings = {
    network: patch.network ?? base.network,
    telemetry: patch.telemetry ?? base.telemetry,
    mcp: patch.mcp ? { ...patch.mcp, token: base.mcp.token } : base.mcp,
  };
  await persist(next);
  current = next;
  return next;
}

export async function regenerateMcpToken(): Promise<AppSettings> {
  const base = await loadAppSettings();
  const next: AppSettings = { ...base, mcp: { ...base.mcp, token: generateMcpToken() } };
  await persist(next);
  current = next;
  return next;
}
