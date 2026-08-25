import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';

// A transient or stale-cached 401 (e.g. the backend's Azure CLI login probe
// racing a cold `az account show` spawn) shouldn't immediately yank the user
// into the Azure connect view while their kubeconfig auth is actually fine.
// Only report the failure once it has persisted for this long.
const AZURE_AUTH_REQUIRED_DEBOUNCE_MS = 10000;

export function azureAuthSourceFromError(error: unknown): 'local' | 'cloud' | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = (error.details ?? null) as { code?: string; source?: string } | null;
  if (details?.code !== 'AZURE_AUTH_REQUIRED') return undefined;
  return details.source === 'local' ? 'local' : 'cloud';
}

export function useAzureAuthRequiredEffect(
  error: unknown,
  onAzureAuthRequired: ((source?: 'local' | 'cloud') => void) | undefined,
): void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!(error instanceof ApiError) || error.status !== 401) return;

    const source = azureAuthSourceFromError(error);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      onAzureAuthRequired?.(source);
    }, AZURE_AUTH_REQUIRED_DEBOUNCE_MS);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [error, onAzureAuthRequired]);
}
