import type { Request, Response } from 'express';
import { Router } from 'express';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireSession } from '../auth/sessions.js';
import { createLicenseForUser, resetQuotaForSubscription } from '../licenseStore.js';
import { getEffectiveLicenseForUser } from '../org/entitlement.js';
import { activateOrgFromCheckout, markOrgCancelled, syncOrgFromSubscription } from '../org/billing.js';
import { findOrgByOwner, findActiveMembership } from '../org/store.js';
import { buildProLineItem, parseInterval } from './pricing.js';
import { isStripeConfigured, stripeClient } from './stripe.js';
import { isStripeDemoMode, createDemoCheckoutSession } from './stripe-sim.js';

const router = Router();
export const billingRouter = router;

// A real deployment would tier this by Stripe price ID; one plan is enough for v1 — its
// quota comes from config.pricing.proQuota (see billing/pricing.ts), not a hardcoded number.
const PAID_PLAN = 'pro';

// Granted in place of a real subscription whenever Stripe isn't configured yet — lets AI
// assistant access ship before billing is wired up, without a separate "is billing enabled"
// flag anywhere else. Once Stripe is configured, a real checkout.session.completed webhook
// simply replaces this trial license the same way it replaces any other (createLicenseForUser
// upserts by user_id).
const TRIAL_PLAN = 'trial';
const TRIAL_PLAN_QUOTA = 100;

router.post('/checkout', requireSession, async (req, res) => {
  // Team members cannot buy individual Pro licenses — they're covered by their org.
  // They must leave the org first if they want to switch to an individual license.
  const teamMembership = findActiveMembership(req.user!.id);
  if (teamMembership) {
    res.status(409).json({ error: "You're covered by your team's plan. Leave the organization first if you want to buy an individual license." });
    return;
  }

  // A phone-only (mobile OTP) account has no email for Stripe to send receipts to —
  // require a verified email before subscribing, same rationale as the plan's "gate
  // checkout on a verified email" security note.
  if (!req.user!.email || !req.user!.emailVerified) {
    res.status(400).json({ error: 'Verify your email before subscribing' });
    return;
  }

  const { interval } = req.body as { interval?: string };

  // Demo mode: simulate Stripe checkout without API calls (checked before real Stripe)
  if (isStripeDemoMode()) {
    const demoSession = createDemoCheckoutSession({
      line_items: [buildProLineItem(parseInterval(interval), 1)],
      customer_email: req.user!.email,
      client_reference_id: req.user!.id,
      success_url: `${config.publicUrl}/account?checkout=success`,
      cancel_url: `${config.publicUrl}/account?checkout=cancelled`,
    });
    res.json({
      url: demoSession.url,
      demo: true,
      sessionId: demoSession.id,
      note: 'Demo mode: call POST /v1/dev/stripe/webhook/checkout-completed with sessionId to simulate completion',
    });
    return;
  }

  if (!isStripeConfigured()) {
    // Only a stand-in for real billing when the account has no currently-active
    // entitlement (personal OR Team) — otherwise this would silently reset quota and wipe
    // a trial's expiry for someone who already has one (previously reachable by clicking
    // "Subscribe" mid-trial), or mint a free personal license for someone a Team already
    // covers. Once the active entitlement lapses, the fallback still applies — that's what
    // keeps a self-hosted install without Stripe from being permanently locked out.
    const existing = getEffectiveLicenseForUser(req.user!.id);
    if (existing?.status === 'active') {
      res.status(503).json({ error: 'Billing is not configured on this server' });
      return;
    }
    createLicenseForUser(req.user!.id, { plan: TRIAL_PLAN, quotaRemaining: TRIAL_PLAN_QUOTA });
    res.json({ trialGranted: true });
    return;
  }

  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [buildProLineItem(parseInterval(interval), 1)],
    customer_email: req.user!.email,
    client_reference_id: req.user!.id,
    success_url: `${config.publicUrl}/account?checkout=success`,
    cancel_url: `${config.publicUrl}/account?checkout=cancelled`,
  });
  res.json({ url: session.url });
});

router.post('/portal', requireSession, async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }
  let license = db.prepare(`SELECT stripe_customer_id FROM licenses WHERE user_id = ?`).get(req.user!.id) as
    | { stripe_customer_id: string | null }
    | undefined;
  // A Team owner's Stripe customer lives on the org's pooled license row (user_id NULL,
  // org_id set), not one keyed by their own user_id — fall back to it.
  if (!license?.stripe_customer_id) {
    const org = findOrgByOwner(req.user!.id);
    if (org) {
      license = db.prepare(`SELECT stripe_customer_id FROM licenses WHERE org_id = ?`).get(org.id) as
        | { stripe_customer_id: string | null }
        | undefined;
    }
  }
  if (!license?.stripe_customer_id) {
    res.status(400).json({ error: 'No billing account found for this user yet' });
    return;
  }

  const stripe = stripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: license.stripe_customer_id,
    return_url: `${config.publicUrl}/account`,
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
  let event: Stripe.Event;

  // Demo mode: accept pre-constructed events without signature verification
  if (isStripeDemoMode()) {
    const body = req.body as Buffer | Stripe.Event;
    if (typeof body === 'object' && 'type' in body && 'data' in body) {
      event = body as Stripe.Event;
    } else {
      res.status(400).json({ error: 'Invalid demo event format' });
      return;
    }
  } else {
    const signature = req.headers['stripe-signature'];
    if (!isStripeConfigured() || !config.stripe.webhookSecret || !signature) {
      res.status(400).send('Webhook not configured');
      return;
    }

    const stripe = stripeClient();
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, config.stripe.webhookSecret);
    } catch (err) {
      res.status(400).send(`Webhook signature verification failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return;
    }
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
      // An individual checkout has no metadata at all — this branch, and everything below
      // it in this case, is unchanged from before Team plans existed.
      if (session.metadata?.fk_purchase === 'org' && session.metadata.fk_org_id) {
        await activateOrgFromCheckout(session);
        break;
      }
      const userId = session.client_reference_id;
      if (userId) {
        createLicenseForUser(userId, { plan: PAID_PLAN, quotaRemaining: config.pricing.proQuota });
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
      // No-op when this subscription isn't a Team's — reconciles seats_purchased (and the
      // pool's grant) if it drifted, e.g. a change made directly in the Stripe dashboard.
      syncOrgFromSubscription(subscription);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      db.prepare(`UPDATE licenses SET status = 'inactive', updated_at = ? WHERE stripe_subscription_id = ?`).run(
        new Date().toISOString(),
        subscription.id,
      );
      markOrgCancelled(subscription.id); // no-op when not a Team's subscription
      break;
    }
    case 'invoice.paid': {
      // Credits reset every billing cycle for both individual Pro and Team pools (see
      // licenseStore.ts's resetQuotaForSubscription) — previously a license's quota was
      // granted once at checkout and never refilled.
      const invoice = event.data.object as Stripe.Invoice;
      // Recent Stripe API versions moved the subscription reference off the invoice
      // itself and onto invoice.parent.subscription_details.subscription.
      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
      if (invoice.billing_reason === 'subscription_cycle' && subscriptionId) {
        resetQuotaForSubscription(subscriptionId);
      }
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}
