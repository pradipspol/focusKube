import type { Request, Response } from 'express';
import { Router } from 'express';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireSession } from '../auth/sessions.js';
import { createLicenseForUser } from '../licenseStore.js';
import { isStripeConfigured, stripeClient } from './stripe.js';

const router = Router();
export const billingRouter = router;

// A real deployment would tier this by Stripe price ID; one plan/quota is enough for v1.
const PAID_PLAN = 'pro';
const PAID_PLAN_QUOTA = 1000;

router.post('/checkout', requireSession, async (req, res) => {
  if (!isStripeConfigured() || !config.stripe.priceId) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }
  // A phone-only (mobile OTP) account has no email for Stripe to send receipts to —
  // require a verified email before subscribing, same rationale as the plan's "gate
  // checkout on a verified email" security note.
  if (!req.user!.email || !req.user!.emailVerified) {
    res.status(400).json({ error: 'Verify your email before subscribing' });
    return;
  }

  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    customer_email: req.user!.email,
    client_reference_id: req.user!.id,
    success_url: `${config.publicUrl}/dashboard?checkout=success`,
    cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
  });
  res.json({ url: session.url });
});

router.post('/portal', requireSession, async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }
  const license = db.prepare(`SELECT stripe_customer_id FROM licenses WHERE user_id = ?`).get(req.user!.id) as
    | { stripe_customer_id: string | null }
    | undefined;
  if (!license?.stripe_customer_id) {
    res.status(400).json({ error: 'No billing account found for this user yet' });
    return;
  }

  const stripe = stripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: license.stripe_customer_id,
    return_url: `${config.publicUrl}/dashboard`,
  });
  res.json({ url: portalSession.url });
});

function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Registered separately in index.ts with express.raw() BEFORE the global JSON body
 * parser — Stripe's signature verification needs the exact raw request bytes, so this
 * route can't share the app-wide express.json() middleware the rest of the API uses.
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'];
  if (!isStripeConfigured() || !config.stripe.webhookSecret || !signature) {
    res.status(400).send('Webhook not configured');
    return;
  }

  const stripe = stripeClient();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, config.stripe.webhookSecret);
  } catch (err) {
    res.status(400).send(`Webhook signature verification failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return;
  }

  // Stripe redelivers events on timeout/retry — process each event id at most once.
  const already = db.prepare(`SELECT id FROM stripe_events WHERE id = ?`).get(event.id);
  if (already) {
    res.json({ received: true });
    return;
  }
  db.prepare(`INSERT INTO stripe_events (id, processed_at) VALUES (?, ?)`).run(event.id, new Date().toISOString());

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      if (userId) {
        createLicenseForUser(userId, { plan: PAID_PLAN, quotaRemaining: PAID_PLAN_QUOTA });
        db.prepare(
          `UPDATE licenses SET stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = ? WHERE user_id = ?`,
        ).run(stripeIdOf(session.customer), stripeIdOf(session.subscription), new Date().toISOString(), userId);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const status = subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : 'inactive';
      db.prepare(`UPDATE licenses SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?`).run(
        status,
        new Date().toISOString(),
        subscription.id,
      );
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      db.prepare(`UPDATE licenses SET status = 'inactive', updated_at = ? WHERE stripe_subscription_id = ?`).run(
        new Date().toISOString(),
        subscription.id,
      );
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}
