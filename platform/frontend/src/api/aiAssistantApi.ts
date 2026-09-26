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

export interface AiChatSession {
  id: string;
  title: string;
  messages: unknown[];
  updatedAt: number;
}

/** An image attached to a user turn — `data` is raw base64 (no `data:` prefix); the frontend
 * resizes/re-encodes to JPEG client-side before this is built (see AiAssistantPanel.tsx), so
 * `mediaType` is normally 'image/jpeg', but the union covers a passthrough of an already-small
 * source file too. */
export interface AiImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

/** Wire messages sent to /ws/ai. */
export type AiChatOutboundMessage =
  /** Loads server-owned model history for the selected chat session. */
  | { type: 'restore_session'; sessionId: string }
  /** `turnId` identifies this turn for later editing/regenerating (see `edit_message` below)
   * and is otherwise unused by the backend for a fresh message. */
  | { type: 'user_message'; text: string; turnId?: string; focusedResource?: AiFocusedResource; images?: AiImageAttachment[] }
  /** Approve/reject a write-tool proposal previously received as `action_proposed`. `id` is
   * that proposal's tool_use id, used to correlate the decision back to the paused turn.
   * `remember: true` (only meaningful alongside `approved: true`) additionally tells the
   * backend to auto-approve this tool name for the rest of the connection — see `action_auto`
   * below for how a later occurrence of that tool is then reported. */
  | { type: 'action_decision'; id: string; approved: boolean; remember?: boolean }
  /** Rewinds the conversation back to right before the turn identified by `turnId` (dropping
   * everything that turn and any later ones produced) and resends `text` as that turn's user
   * message — used for both "edit a past message" (text differs) and "regenerate" (text is the
   * original, unchanged). `images`, when the original turn had any, are resent verbatim — v1's
   * edit UI doesn't offer changing attachments, only text. */
  | { type: 'edit_message'; turnId: string; text: string; focusedResource?: AiFocusedResource; images?: AiImageAttachment[] }
  /** Aborts whichever turn is currently streaming on this connection, if any. A no-op if
   * nothing is in flight. */
  | { type: 'stop' };

/** A write-tool proposal's before/after view — `before` is absent when the target resource
 * doesn't exist yet (apply_manifest would create it). */
export interface AiActionDiff {
  before?: string;
  after: string;
}

/** Wire messages received from /ws/ai. */
export type AiChatInboundMessage =
  | { type: 'session_restored'; sessionId: string }
  | { type: 'token'; token: string }
  | { type: 'stop' }
  /** The turn ended because the user clicked Stop — distinct from `stop` (a normal end-of-turn)
   * only so the frontend can skip showing anything alarming; whatever text streamed before the
   * abort stays exactly as-is. */
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  /** A read tool (list/get/describe/logs/events) started — auto-executes, no approval needed. */
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  /** That read tool finished; `output` is the (possibly truncated) result text. */
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  /** A write tool (scale/restart/apply/delete) was requested — render an approval card and
   * send an `action_decision` back; nothing has touched the cluster yet. */
  | { type: 'action_proposed'; id: string; name: string; input: unknown; summary: string; diff?: AiActionDiff }
  /** The outcome once the user decided (or the proposal was re-checked and denied). */
  | { type: 'action_result'; id: string; status: 'approved' | 'rejected' | 'failed'; output?: string }
  /** A write tool that matched an earlier "Allow for this session" choice — already executed,
   * with no pending step at all. Render it the same as a resolved action card. */
  | {
      type: 'action_auto';
      id: string;
      name: string;
      input: unknown;
      summary: string;
      diff?: AiActionDiff;
      status: 'approved' | 'failed';
      output: string;
    };

const AI_API_BASE = '/api/ai';

function contextQuery(context?: string): string {
  return context ? `?context=${encodeURIComponent(context)}` : '';
}

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

  async getChatSessions(context?: string): Promise<AiChatSession[]> {
    const res = await fetch(`${AI_API_BASE}/sessions${contextQuery(context)}`, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(await extractErrorMessage(res, 'Failed to load chat sessions'));
    const body = (await res.json()) as { sessions: AiChatSession[] };
    return body.sessions;
  },

  async saveChatSession(session: Pick<AiChatSession, 'id' | 'title' | 'messages'>, context?: string): Promise<void> {
    const res = await fetch(`${AI_API_BASE}/sessions/${encodeURIComponent(session.id)}${contextQuery(context)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: session.title, messages: session.messages }),
    });
    if (!res.ok) throw new Error(await extractErrorMessage(res, 'Failed to save chat session'));
  },

  async importChatSession(
    session: Pick<AiChatSession, 'id' | 'title' | 'messages'>,
    modelMessages: AiChatMessage[],
    context?: string,
  ): Promise<void> {
    const res = await fetch(`${AI_API_BASE}/sessions/${encodeURIComponent(session.id)}/import${contextQuery(context)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: session.title, messages: session.messages, modelMessages }),
    });
    if (!res.ok) throw new Error(await extractErrorMessage(res, 'Failed to import chat session'));
  },

  async deleteChatSession(id: string, context?: string): Promise<void> {
    const res = await fetch(`${AI_API_BASE}/sessions/${encodeURIComponent(id)}${contextQuery(context)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await extractErrorMessage(res, 'Failed to delete chat session'));
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
