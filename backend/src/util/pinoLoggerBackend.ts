import pino from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerBackend, LogLevel, LogPayload } from './logger.types.js';

const logLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
//const fileLogEnabled = (process.env.LOG_TO_FILE ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() !== 'false';
const fileLogEnabled = process.env.LOG_TO_FILE || 'false';
const fileLogPath = resolveFileLogPath();

const fileQueue: string[] = [];
let fileFlushInFlight = false;
let fileFlushScheduled = false;
let currentFileSize: number | null = null;

function normalizeLevel(level: LogLevel): LogLevel {
  return logLevels.includes(level) ? level : 'info';
}

function resolveFileLogPath(): string {
  const explicit = process.env.LOG_FILE_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  const cwd = process.cwd();
  const baseDir = path.basename(cwd).toLowerCase() === 'backend' ? path.dirname(cwd) : cwd;
  return path.join(baseDir, 'focusKube.logs');
}

function scheduleFileFlush(): void {
  if (!fileLogEnabled || fileFlushScheduled || fileFlushInFlight || fileQueue.length === 0) return;
  fileFlushScheduled = true;
  setImmediate(() => {
    fileFlushScheduled = false;
    void flushFileQueue();
  });
}

async function flushFileQueue(): Promise<void> {
  if (!fileLogEnabled || fileFlushInFlight) return;
  fileFlushInFlight = true;
  try {
    while (fileQueue.length > 0) {
      const line = fileQueue.shift();
      if (!line) continue;
      await appendFileLine(line);
    }
  } finally {
    fileFlushInFlight = false;
    if (fileQueue.length > 0) scheduleFileFlush();
  }
}

async function appendFileLine(line: string): Promise<void> {
  await fs.mkdir(path.dirname(fileLogPath), { recursive: true });

  const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
  const currentSize = await ensureFileSize();
  if (currentSize > 0 && currentSize + bytes > 5 * 1024 * 1024) {
    await rotateFileLogs();
  }

  await fs.appendFile(fileLogPath, `${line}\n`, 'utf8');
  currentFileSize = (currentFileSize ?? 0) + bytes;
}

async function ensureFileSize(): Promise<number> {
  if (currentFileSize !== null) return currentFileSize;
  try {
    const stat = await fs.stat(fileLogPath);
    currentFileSize = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      currentFileSize = 0;
    } else {
      throw err;
    }
  }
  return currentFileSize;
}

async function rotateFileLogs(): Promise<void> {
  const base = path.parse(fileLogPath);
  for (let index = 4; index >= 1; index -= 1) {
    const source = path.join(base.dir, `${base.name}-${index}${base.ext || '.logs'}`);
    const target = path.join(base.dir, `${base.name}-${index + 1}${base.ext || '.logs'}`);
    await renameIfExists(source, target);
  }
  await renameIfExists(fileLogPath, path.join(base.dir, `${base.name}-1${base.ext || '.logs'}`));
  currentFileSize = 0;
}

async function renameIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  try {
    await fs.rename(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function createPinoLoggerBackend(): LoggerBackend {
  const logger = pino(
    {
      // Keep transport permissive; logger.ts is the single source of truth for level filtering.
      level: 'debug',
      base: undefined,
      timestamp: false,
      messageKey: 'msg',
      formatters: {
        level(label: string) {
          return { level: label };
        },
        bindings() {
          return {};
        },
      },
    },
    pino.destination({ sync: false }),
  );

  return {
    write(payload: LogPayload): void {
      const { level, msg, ...fields } = payload;
      const normalizedLevel = normalizeLevel(level);
      logger[normalizedLevel](fields, msg);

      if (fileLogEnabled) {
        fileQueue.push(JSON.stringify(payload));
        scheduleFileFlush();
      }
    },
  };
}