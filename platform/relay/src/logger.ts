import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import type { NextFunction, Request, Response } from 'express';

interface LogContext {
  requestId: string;
  method: string;
  route: string;
  userId: string | null;
}

const contextStorage = new AsyncLocalStorage<LogContext>();
const logFile = path.resolve(process.env.FOCUSKUBE_LOG_FILE ?? 'logs/relay.jsonl');
const sensitiveKey = /password|secret|token|authorization|cookie|api.?key|credential|private.?key|otp|session|license|signature/i;
const destination = pino.transport({
  target: 'pino/file',
  options: { destination: logFile, mkdir: true },
});
const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'authorization', '*.authorization', '*.*.authorization',
        'cookie', '*.cookie', '*.*.cookie',
        'password', '*.password', '*.*.password',
        'secret', '*.secret', '*.*.secret',
        'token', '*.token', '*.*.token',
        'apiKey', '*.apiKey', '*.*.apiKey',
        'api_key', '*.api_key', '*.*.api_key',
        'otp', '*.otp', '*.*.otp',
        'session', '*.session', '*.*.session',
        'license', '*.license', '*.*.license',
        'signature', '*.signature', '*.*.signature',
      ],
      censor: '[redacted]',
    },
    base: null,
  },
  destination,
);

function safeFieldNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 40).map((key) => (sensitiveKey.test(key) ? '[redacted]' : key));
}

function summarizeInput(req: Request): Record<string, unknown> {
  const body = req.body;
  return {
    bodyType: Buffer.isBuffer(body) ? 'buffer' : Array.isArray(body) ? 'array' : typeof body,
    bodyFields: safeFieldNames(body),
    queryFields: safeFieldNames(req.query),
    parameterFields: safeFieldNames(req.params),
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(
      /((?:password|secret|token|authorization|api[_-]?key|otp|session|license|signature)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]',
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|signature|code|handoff|session|license|password|otp)=)[^&#\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\+?\d[\d ().-]{7,}\d/g, '[redacted-phone]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-value]')
    .slice(0, 500);
}

function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error };
  const errorCode = 'code' in error ? error.code : undefined;
  const cause = 'cause' in error ? error.cause : undefined;
  const causeCode = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return {
    type: error.name,
    message: sanitizeErrorMessage(error.message),
    ...(typeof errorCode === 'string' || typeof errorCode === 'number' ? { code: errorCode } : {}),
    ...(cause instanceof Error ? { causeType: cause.name } : {}),
    ...(typeof causeCode === 'string' || typeof causeCode === 'number' ? { causeCode } : {}),
  };
}

function errorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 500;
  const candidate = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : undefined;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 600 ? candidate : 500;
}

function safeResponseReason(value: unknown): string | undefined {
  const reason =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : undefined;
  if (!reason || reason.length > 1000 || reason.trimStart().startsWith('<')) return undefined;
  return sanitizeErrorMessage(reason);
}

function writeLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data: Record<string, unknown> = {},
): void {
  logger[level](
    {
      ...data,
      event: message,
      context: {
        requestId: null,
        method: null,
        route: null,
        userId: null,
        ...contextStorage.getStore(),
      },
    },
    message,
  );
}

export function logDebug(message: string, data: Record<string, unknown> = {}): void {
  writeLog('debug', message, data);
}

export function logInfo(message: string, data: Record<string, unknown> = {}): void {
  writeLog('info', message, data);
}

export function logWarning(message: string, data: Record<string, unknown> = {}): void {
  writeLog('warn', message, data);
}

export function logError(message: string, error?: unknown, data: Record<string, unknown> = {}): void {
  writeLog('error', message, {
    ...data,
    ...(error === undefined ? {} : { error: safeError(error) }),
  });
}

export function updateLogContext(patch: Partial<Pick<LogContext, 'userId'>>): void {
  const context = contextStorage.getStore();
  if (context) Object.assign(context, patch);
}

export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const context: LogContext = {
    requestId: randomUUID(),
    method: req.method,
    route: req.baseUrl || '/',
    userId: null,
  };
  res.locals.requestId = context.requestId;
  res.setHeader('X-Request-Id', context.requestId);

  contextStorage.run(context, () => {
    logDebug('HTTP request started');
    res.on('finish', () => {
      const route = req.route?.path;
      context.route = `${req.baseUrl}${typeof route === 'string' ? route : ''}` || '/';
      const details = {
        durationMs: Date.now() - startedAt,
        input: summarizeInput(req),
        output: {
          statusCode: res.statusCode,
          contentType: res.getHeader('content-type') ?? null,
          responseFields: safeFieldNames(res.locals.logResponse),
        },
        ...(res.statusCode >= 400 ? { reason: safeResponseReason(res.locals.logResponse) } : {}),
        ...(res.locals.logError ? { errorType: res.locals.logError.type } : {}),
      };
      if (res.statusCode >= 400) {
        logError(`HTTP request failed with status ${res.statusCode}`, undefined, details);
      } else {
        logInfo(`HTTP request completed with status ${res.statusCode}`, details);
      }
    });

    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      res.locals.logResponse = body;
      return json(body as never);
    }) as Response['json'];
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (res.locals.logResponse === undefined && typeof body === 'string' && body.length <= 1000) {
        res.locals.logResponse = body;
      }
      return send(body as never);
    }) as Response['send'];
    next();
  });
}

export function requestErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const statusCode = errorStatus(error);
  const details = safeError(error);
  res.locals.logError = details;
  logError('Unhandled HTTP request error', error, { statusCode, method: req.method });

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : 'Invalid request',
    requestId: res.locals.requestId ?? null,
  });
}

export async function flushLogs(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logger.flush((error) => (error ? reject(error) : resolve()));
  });
}