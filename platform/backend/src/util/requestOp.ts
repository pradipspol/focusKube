import type { Request } from 'express';
import { logInfo } from './logger.js';
import { setLogContext } from './logger.js';

export function setRequestOperation(req: Request, operation: string): void {
  if (req.logOperation === operation) return;
  req.logOperation = operation;
  setLogContext({ operation });
  logInfo('http.request.operation', {
    reqId: req.logRequestId ?? null,
    method: req.method,
    path: req.originalUrl || req.url,
    operation,
  });
}

export function getRequestOperation(req: Request): string | undefined {
  return req.logOperation;
}
