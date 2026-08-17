import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { getLoggerBackend } from './loggerBackend.js';
import type { LogLevel, LogPayload } from './logger.types.js';

export type LogContext = Record<string, unknown>;

const logContextStorage = new AsyncLocalStorage<LogContext>();

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(raw?: string): LogLevel {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

function overrideFilePath(): string {
  return path.join(config.sessionStorageDir, 'desktop-log-level.json');
}

function readDesktopOverrideLevel(): LogLevel | undefined {
  try {
    const raw = fs.readFileSync(overrideFilePath(), 'utf8');
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as { level?: string };
    if (!parsed?.level) return undefined;
    return normalizeLevel(parsed.level);
  } catch {
    return undefined;
  }
}

function writeDesktopOverrideLevel(level: LogLevel): void {
  try {
    fs.mkdirSync(config.sessionStorageDir, { recursive: true });
    fs.writeFileSync(overrideFilePath(), JSON.stringify({ level }, null, 2), 'utf8');
  } catch {
    // best-effort persistence; logging should continue even if file write fails
  }
}

const envLevel = normalizeLevel(process.env.LOG_LEVEL);
let uiOverrideLevel: LogLevel | undefined = readDesktopOverrideLevel();
let currentLevel: LogLevel = uiOverrideLevel ?? envLevel;
let currentPriority = priorities[currentLevel];

function shouldLog(level: LogLevel): boolean {
  return priorities[level] >= currentPriority;
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContextStorage.run({ ...context }, callback);
}

export function setLogContext(context: LogContext): void {
  const current = logContextStorage.getStore();
  if (current) {
    Object.assign(current, context);
    return;
  }
  logContextStorage.enterWith({ ...context });
}

function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return;

  const context = logContextStorage.getStore() ?? {};

  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
    ...fields,
  };

  getLoggerBackend().write(payload);
}

export function logDebug(message: string, fields: Record<string, unknown> = {}): void {
  log('debug', message, fields);
}

export function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  log('info', message, fields);
}

export function logWarn(message: string, fields: Record<string, unknown> = {}): void {
  log('warn', message, fields);
}

export function logError(message: string, fields: Record<string, unknown> = {}): void {
  log('error', message, fields);
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setLogLevel(level: LogLevel): LogLevel {
  const normalized = normalizeLevel(level);
  uiOverrideLevel = normalized;
  writeDesktopOverrideLevel(normalized);
  currentLevel = normalized;
  currentPriority = priorities[currentLevel];
  return currentLevel;
}

export function getEnvLogLevel(): LogLevel {
  return envLevel;
}

export function hasUiLogLevelOverride(): boolean {
  return Boolean(uiOverrideLevel);
}
