import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { HttpError } from '../util/httpError.js';
import { logError, logInfo } from '../util/logger.js';
import { getEntitlementState } from '../runtime/aiLicenseStore.js';
import { getSessionToken } from '../runtime/accountStore.js';
import { aiChatSessionStore } from '../services/aiChatSessionStore.js';
import type { ChatMessage } from '../services/aiService.js';

const router = Router();

interface EntitlementResponse {
  enabled: boolean;
  plan?: string;
  status?: string;
  quotaRemaining?: number;
  error?: string;
}

export const aiRouter = router;

function chatContext(req: Request): string {
  const requested = req.query.context;
  return typeof requested === 'string' && requested ? requested : (req as any).userSession?.activeContext || 'default';
}

function recoverTranscript(session: {
  id: string;
  messages: Array<{ id: string; kind: string; [key: string]: unknown }>;
  modelMessages: ChatMessage[];
  checkpoints: Array<{ turnId: string; index: number }>;
}) {
  if (session.messages.length > 0) return session.messages;

  const turnIds = new Map(session.checkpoints.map((checkpoint) => [checkpoint.index, checkpoint.turnId]));
  return session.modelMessages.flatMap((message, index) => {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    if (!content) return [];
    return [{
      id: `recovered-${session.id}-${index}`,
      kind: 'text',
      role: message.role,
      content,
      ...(message.role === 'user' && turnIds.has(index) ? { turnId: turnIds.get(index) } : {}),
    }];
  });
}

// GET /api/ai/entitlement — Check if the signed-in account has an active AI license.
router.get('/entitlement', async (_req: Request, res: Response<EntitlementResponse>, next: NextFunction) => {
  try {
    const state = await getEntitlementState();
    res.json({
      enabled: state.status === 'active',
      plan: state.plan,
      status: state.status,
      quotaRemaining: state.quotaRemaining,
      error: state.error,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/checkout — Start a Stripe Checkout session for the signed-in account,
// proxied to the relay (which owns Stripe config and the account/license linkage).
router.post('/checkout', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const token = await getSessionToken();
    if (!token) {
      throw new HttpError(401, 'Not signed in');
    }

    let relayResponse: globalThis.Response;
    try {
      relayResponse = await fetch(`${config.aiRelayBaseUrl}/v1/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${config.accountSessionCookieName}=${token}`,
        },
        body: JSON.stringify({}),
      });
    } catch (err) {
      logError('ai_checkout.relay_unreachable', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HttpError(503, 'Billing service is temporarily unavailable');
    }

    const body = (await relayResponse.json().catch(() => ({}))) as {
      url?: string;
      trialGranted?: boolean;
      error?: string;
    };
    if (!relayResponse.ok) {
      throw new HttpError(relayResponse.status, body.error ?? 'Failed to start checkout');
    }

    logInfo('ai_checkout.started', {});
    res.json(body);
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new HttpError(401, 'Not signed in');
    res.json({
      sessions: aiChatSessionStore
        .list(userId, chatContext(req))
        .map((session) => ({
          id: session.id,
          title: session.title,
          messages: recoverTranscript(session),
          updatedAt: session.updatedAt,
        })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/sessions/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new HttpError(401, 'Not signed in');
    const { title, messages } = req.body ?? {};
    if (
      typeof req.params.id !== 'string' ||
      req.params.id.length > 128 ||
      typeof title !== 'string' ||
      !Array.isArray(messages) ||
      messages.length > 1000 ||
      JSON.stringify(messages).length > 4_000_000 ||
      messages.some((message: any) => !message || typeof message.id !== 'string' || !['text', 'tool', 'action'].includes(message.kind))
    ) {
      throw new HttpError(400, 'Invalid chat session transcript');
    }
    const session = aiChatSessionStore.saveTranscript(userId, chatContext(req), req.params.id, title, messages);
    res.json({ id: session.id, title: session.title, messages: session.messages, updatedAt: session.updatedAt });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/import', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new HttpError(401, 'Not signed in');
    const { title, messages, modelMessages } = req.body ?? {};
    if (
      typeof req.params.id !== 'string' ||
      req.params.id.length > 128 ||
      typeof title !== 'string' ||
      !Array.isArray(messages) ||
      !Array.isArray(modelMessages) ||
      messages.length > 1000 ||
      modelMessages.length > 500 ||
      JSON.stringify(messages).length > 4_000_000 ||
      JSON.stringify(modelMessages).length > 500_000 ||
      messages.some((message: any) => !message || typeof message.id !== 'string' || !['text', 'tool', 'action'].includes(message.kind)) ||
      modelMessages.some((message: any) => !message || !['user', 'assistant'].includes(message.role))
    ) {
      throw new HttpError(400, 'Invalid chat session import');
    }
    const session = aiChatSessionStore.importSession(userId, chatContext(req), req.params.id, title, messages, modelMessages);
    res.json({ id: session.id, title: session.title, messages: session.messages, updatedAt: session.updatedAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new HttpError(401, 'Not signed in');
    aiChatSessionStore.delete(userId, chatContext(req), req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
