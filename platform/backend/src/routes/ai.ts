import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { HttpError } from '../util/httpError.js';
import { logError, logInfo } from '../util/logger.js';
import { getEntitlementState } from '../runtime/aiLicenseStore.js';
import { getSessionToken } from '../runtime/accountStore.js';

const router = Router();

interface EntitlementResponse {
  enabled: boolean;
  plan?: string;
  status?: string;
  quotaRemaining?: number;
  error?: string;
}

export const aiRouter = router;

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
