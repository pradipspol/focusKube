import { useMutation, useQuery } from '@tanstack/react-query';
import { wsUrl } from './client';

export interface AiEntitlement {
  enabled: boolean;
  plan?: string;
  status?: string;
  quotaRemaining?: number;
  error?: string;
}

export interface AiFocusedResource {
  kind: string;
  namespace: string;
  name: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Wire messages sent to /ws/ai. */
export type AiChatOutboundMessage = {
  type: 'user_message';
  text: string;
  focusedResource?: AiFocusedResource;
};

/** Wire messages received from /ws/ai. */
export type AiChatInboundMessage =
  | { type: 'token'; token: string }
  | { type: 'tool_use'; [key: string]: unknown }
  | { type: 'stop' }
  | { type: 'error'; message: string };

const AI_API_BASE = '/api/ai';

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    // response body wasn't JSON - use the fallback below
  }
  return fallback;
}

/**
 * API client for the AI assistant's entitlement/license endpoints.
 * The chat itself streams over /ws/ai — see openAiChatSocket below.
 */
export const aiAssistantApi = {
  async getEntitlement(): Promise<AiEntitlement> {
    const res = await fetch(`${AI_API_BASE}/entitlement`);
    // A 503 still carries a meaningful {enabled: false, error} body (e.g. relay
    // unreachable with no cached grace-period state) — only throw on a body-less failure.
    if (!res.ok && res.status !== 503) {
      throw new Error(await extractErrorMessage(res, 'Failed to check AI entitlement'));
    }
    return res.json();
  },

  /** `url` to open when Stripe is configured; `trialGranted` when it isn't yet (see relay's
   * billing/routes.ts) — the caller should just refetch entitlement in that case. */
  async requestCheckout(): Promise<{ url?: string; trialGranted?: boolean }> {
    const res = await fetch(`${AI_API_BASE}/checkout`, { method: 'POST' });
    if (!res.ok) throw new Error(await extractErrorMessage(res, 'Failed to start checkout'));
    return res.json();
  },
};

/**
 * React hooks for the AI assistant
 */

// Polls at the same cadence as the backend's positive-entitlement cache TTL, so a
// revoked/expired license is reflected in the UI without a page reload. `enabled` defaults
// to true for AiEntitlementGate's own call; App.tsx passes `!!user` so the check starts
// right after sign-in (same query key, so the tab reuses the already-warm cache) instead of
// waiting until the AI Assistant tab is actually opened.
export const useAiEntitlement = (enabled = true) => {
  return useQuery({
    queryKey: ['ai', 'entitlement'],
    queryFn: () => aiAssistantApi.getEntitlement(),
    refetchInterval: 15000,
    retry: false,
    enabled,
  });
};

export const useRequestCheckout = () => {
  return useMutation({
    mutationFn: () => aiAssistantApi.requestCheckout(),
  });
};

/** Opens the streaming chat socket for the AI assistant. Caller owns the returned WebSocket's lifecycle. */
export function openAiChatSocket(context?: string): WebSocket {
  return new WebSocket(wsUrl('/ws/ai', { context }));
}
