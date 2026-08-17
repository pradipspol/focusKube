import { createPinoLoggerBackend } from './pinoLoggerBackend.js';
import type { LoggerBackend } from './logger.types.js';

let backend: LoggerBackend | null = null;

export function getLoggerBackend(): LoggerBackend {
  if (!backend) backend = createPinoLoggerBackend();
  return backend;
}

export function setLoggerBackend(nextBackend: LoggerBackend): void {
  backend = nextBackend;
}