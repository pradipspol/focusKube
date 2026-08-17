import type { RequestHandler } from 'express';
import { logError } from './logger.js';
import { getRequestOperation } from './requestOp.js';

/**
 * Lightweight HTTP error used by routes. The error middleware turns these into
 * JSON responses with the right status code.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);
export const notFound = (message: string) => new HttpError(404, message);
export const serverError = (message: string, details?: unknown) =>
  new HttpError(500, message, details);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/**
 * Wraps a route handler so failures are logged once with route context before
 * they bubble into the central HttpError middleware.
 */
export function withRouteErrorLogging(api: string, route: string, handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (err) {
      logError('http.route.error', {
        reqId: req.logRequestId ?? null,
        api,
        route,
        operation: getRequestOperation(req) ?? null,
        method: req.method,
        path: req.originalUrl || req.url,
        error: errorMessage(err),
        stack: errorStack(err),
        statusCode: err instanceof HttpError ? err.status : undefined,
        details: err instanceof HttpError ? err.details ?? null : null,
      });
      throw err;
    }
  };
}
