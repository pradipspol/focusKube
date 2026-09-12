/**
 * Development-only endpoints for testing without real Stripe. Only available
 * when Stripe demo mode is enabled (STRIPE_DEMO_MODE=true or no STRIPE_SECRET_KEY in dev).
 */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { config } from '../config.js';
import {
  isStripeDemoMode,
  simulateCheckoutCompleted,
  simulateSubscriptionUpdated,
  simulateInvoicePaid,
  listSimulatedSessions,
  listSimulatedSubscriptions,
  getSimulatedSession,
  getSimulatedSubscription,
} from '../billing/stripe-sim.js';

const router = Router();
export const devRouter = router;

// Guard: only available in demo mode
function requireDemoMode(req: Request, res: Response, next: () => void) {
  if (!isStripeDemoMode()) {
    res.status(403).json({ error: 'Dev endpoints only available in Stripe demo mode' });
    return;
  }
  next();
}

router.use(requireDemoMode);

/**
 * List all simulated checkout sessions.
 * GET /v1/dev/stripe/sessions
 */
router.get('/stripe/sessions', (req, res) => {
  const sessions = listSimulatedSessions();
  res.json({ sessions, count: sessions.length });
});

/**
 * List all simulated subscriptions.
 * GET /v1/dev/stripe/subscriptions
 */
router.get('/stripe/subscriptions', (req, res) => {
  const subscriptions = listSimulatedSubscriptions();
  res.json({ subscriptions, count: subscriptions.length });
});

/**
 * Get a simulated session by ID.
 * GET /v1/dev/stripe/sessions/:sessionId
 */
router.get('/stripe/sessions/:sessionId', (req, res) => {
  const session = getSimulatedSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

/**
 * Get a simulated subscription by ID.
 * GET /v1/dev/stripe/subscriptions/:subscriptionId
 */
router.get('/stripe/subscriptions/:subscriptionId', (req, res) => {
  const subscription = getSimulatedSubscription(req.params.subscriptionId);
  if (!subscription) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }
  res.json(subscription);
});

/**
 * Simulate checkout.session.completed webhook.
 * POST /v1/dev/stripe/webhook/checkout-completed
 * Body: { sessionId: string }
 */
router.post('/stripe/webhook/checkout-completed', async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId' });
    return;
  }

  try {
    await simulateCheckoutCompleted(sessionId);
    const session = getSimulatedSession(sessionId);
    res.json({
      success: true,
      message: 'Checkout.session.completed webhook simulated',
      session,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to simulate webhook',
    });
  }
});

/**
 * Simulate customer.subscription.updated webhook.
 * POST /v1/dev/stripe/webhook/subscription-updated
 * Body: { subscriptionId: string, status: 'active' | 'canceled' }
 */
router.post('/stripe/webhook/subscription-updated', async (req, res) => {
  const { subscriptionId, status } = req.body as { subscriptionId?: string; status?: string };
  if (!subscriptionId || !status) {
    res.status(400).json({ error: 'Missing subscriptionId or status' });
    return;
  }

  if (status !== 'active' && status !== 'canceled') {
    res.status(400).json({ error: 'Status must be "active" or "canceled"' });
    return;
  }

  try {
    await simulateSubscriptionUpdated(subscriptionId, status);
    const subscription = getSimulatedSubscription(subscriptionId);
    res.json({
      success: true,
      message: 'Customer.subscription.updated webhook simulated',
      subscription,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to simulate webhook',
    });
  }
});

/**
 * Simulate invoice.paid webhook (billing cycle quota reset).
 * POST /v1/dev/stripe/webhook/invoice-paid
 * Body: { subscriptionId: string }
 */
router.post('/stripe/webhook/invoice-paid', async (req, res) => {
  const { subscriptionId } = req.body as { subscriptionId?: string };
  if (!subscriptionId) {
    res.status(400).json({ error: 'Missing subscriptionId' });
    return;
  }

  try {
    await simulateInvoicePaid(subscriptionId);
    res.json({
      success: true,
      message: 'Invoice.paid webhook simulated (quota reset)',
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to simulate webhook',
    });
  }
});

/**
 * Quick summary of current demo state.
 * GET /v1/dev/stripe/status
 */
router.get('/stripe/status', (req, res) => {
  res.json({
    demoMode: true,
    sessions: listSimulatedSessions().length,
    subscriptions: listSimulatedSubscriptions().length,
    endpoints: {
      'GET /v1/dev/stripe/sessions': 'List all checkout sessions',
      'GET /v1/dev/stripe/sessions/:sessionId': 'Get a session',
      'GET /v1/dev/stripe/subscriptions': 'List all subscriptions',
      'GET /v1/dev/stripe/subscriptions/:subscriptionId': 'Get a subscription',
      'POST /v1/dev/stripe/webhook/checkout-completed': 'Simulate checkout.session.completed',
      'POST /v1/dev/stripe/webhook/subscription-updated': 'Simulate customer.subscription.updated',
      'POST /v1/dev/stripe/webhook/invoice-paid': 'Simulate invoice.paid (quota reset)',
    },
  });
});
