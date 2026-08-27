import type { Request } from 'express';
import {
  azureConfigDirForSource,
  kubeconfigPathForSource,
  resolveSessionScopeForContext,
  type SessionScope,
} from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';

export interface ScopedRequestContext {
  requestedContext: string | undefined;
  requestedSource: string | undefined;
  selectedScope: SessionScope;
  selectedKubeconfigPath: string;
  selectedAzureConfigDir: string;
}

export function requestedContextFromQuery(req: Request): string | undefined {
  const value = req.query.context;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function requestedSourceFromQuery(req: Request): string | undefined {
  const value = req.query.source;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function resolveScopedRequestContext(
  req: Request,
  overrides: { context?: string; source?: string } = {},
): Promise<ScopedRequestContext> {
  const requestedContext = overrides.context ?? requestedContextFromQuery(req);
  const requestedSource = overrides.source ?? requestedSourceFromQuery(req);
  const selectedScope = await resolveSessionScopeForContext(req.userSession, requestedContext, requestedSource);
  const selectedKubeconfigPath = kubeconfigPathForSource(req.userSession, selectedScope);
  const selectedAzureConfigDir = azureConfigDirForSource(req.userSession, selectedScope);

  return {
    requestedContext,
    requestedSource,
    selectedScope,
    selectedKubeconfigPath,
    selectedAzureConfigDir,
  };
}

export function kubeOptionsForScope(req: Request, scoped: ScopedRequestContext): { kubeconfigPath: string; fallbackContext: string | null; azureConfigDir: string } {
  return {
    kubeconfigPath: scoped.selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: scoped.selectedAzureConfigDir,
  };
}

export async function ensureScopedContextAuth(req: Request, scoped: ScopedRequestContext): Promise<void> {
  await ensureContextAuthReady({
    context: scoped.requestedContext,
    kubeconfigPath: scoped.selectedKubeconfigPath,
    fallbackContext: req.userSession.activeContext,
    azureConfigDir: scoped.selectedAzureConfigDir,
    source: scoped.selectedScope,
    userId: req.authUser?.id,
    azureLogin: req.userSession.azureLogin,
  });
}