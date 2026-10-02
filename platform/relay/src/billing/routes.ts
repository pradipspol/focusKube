import type { Request, Response } from 'express';
import { Router } from 'express';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { mongoCollections } from '../mongoCollections.js';
import { requireSession } from '../auth/sessions.js';
import { createLicenseForUser } from '../licenseStore.js';
import { getEffectiveLicenseForUser } from '../org/entitlement.js';
import { organizationService } from '../org/organizationService.js';
import { parseInterval } from './pricing.js';
import { activeProvider, BillingConfigError } from './provider.js';
import { RazorpayError } from './razorpay.js';
import { stripeClient } from './stripe.js';
import { isStripeDemoMode } from './stripe-sim.js';
import { logError, logWarning } from '../logger.js';
import { logDebug, logInfo } from '../logger.js';
import {
  activateIndividualSubscription,
  activateOrgSubscription,
  claimBillingEvent,
  endSubscription,
  releaseBillingEvent,
  renewSubscriptionQuota,
  setSubscriptionStatus,
  syncSeatsForSubscription,
} from './effects.js';

const router = Router();
export const billingRouter = router;

// Granted in place of a real subscription whenever no payment provider is configured yet Ã¢â‚¬â€
// lets AI assistant access ship before billing is wired up, without a separate "is billing
// enabled" flag anywhere else. Once a provider is configured, a real activation webhook
// simply replaces this trial license the same way it replaces any other
// (createLicenseForUser upserts by user_id).
const TRIAL_PLAN = 'trial';
const TRIAL_PLAN_QUOTA = 100;

/** Surfaces a provider's own refusal (e.g. Razorpay rejecting a seat change on a UPI
 * subscription) instead of collapsing it into a generic 500. */
function sendBillingError(res: Response, err: unknown): void {
  if (err instanceof RazorpayError || err instanceof BillingConfigError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    logWarning('Payment provider rejected a billing operation', { statusCode: status, errorType: err.name });
    res.status(status).json({ error: err.message });
    return;
  }
  logError('Unexpected billing provider failure', err);
  res.status(502).json({ error: 'Payment provider request failed' });
}

router.post('/checkout', requireSession, async (req, res) => {
  // Team members cannot buy individual Pro licenses Ã¢â‚¬â€ they're covered by their org.
  // They must leave the org first if they want to switch to an individual license.
  const teamMembership = await organizationService.findActiveMembership(req.user!.id);
  if (teamMembership) {
    res.status(409).json({ error: "You're covered by your team's plan. Leave the organization first if you want to buy an individual license." });
    return;
  }

  // A phone-only (mobile OTP) account has no email for receipts Ã¢â‚¬â€ require a verified email
  // before subscribing, same rationale as the plan's "gate checkout on a verified email"
  // security note.
  if (!req.user!.email || !req.user!.emailVerified) {
    res.status(400).json({ error: 'Verify your email before subscribing' });
    return;
  }

  const provider = activeProvider();

  if (!provider.isConfigured()) {
    // Only a stand-in for real billing when the account has no currently-active entitlement
    // (personal OR Team) Ã¢â‚¬â€ otherwise this would silently reset quota and wipe a trial's
    // expiry for someone who already has one, or mint a free personal license for someone a
    // Team already covers. Once the active entitlement lapses the fallback applies again Ã¢â‚¬â€
    // that's what keeps a self-hosted install without billing from being locked out forever.
    const existing = await getEffectiveLicenseForUser(req.user!.id);
    if (existing?.status === 'active') {
      res.status(503).json({ error: 'Billing is not configured on this server' });
      return;
    }
    await createLicenseForUser(req.user!.id, { plan: TRIAL_PLAN, quotaRemaining: TRIAL_PLAN_QUOTA });
    res.json({ trialGranted: true });
    return;
  }

  try {
    const result = await provider.createCheckout({
      user: req.user!,
      interval: parseInterval((req.body as { interval?: string }).interval),
      quantity: 1,
      purpose: 'individual',
    });
    res.json(result);
  } catch (err) {
    sendBillingError(res, err);
  }
});

router.post('/portal', requireSession, async (req, res) => {
  const provider = activeProvider();
  if (!provider.supportsPortal()) {
    res.status(503).json({ error: 'Self-serve billing management is not available for this payment provider' });
    return;
  }
  if (!provider.isConfigured()) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }

  let license = await mongoCollections.licenses.findOne({ user_id: req.user!.id });
  // A Team owner's customer record lives on the org's pooled license row (user_id NULL,
  // org_id set), not one keyed by their own user_id Ã¢â‚¬â€ fall back to it.
  if (!license?.stripe_customer_id) {
    const org = await organizationService.findOrgByOwner(req.user!.id);
    if (org) {
      license = await mongoCollections.licenses.findOne({ org_id: org.id });
    }
  }
  if (!license?.stripe_customer_id) {
    res.status(400).json({ error: 'No billing account found for this user yet' });
    return;
  }

  try {
    const session = await provider.createPortalSession(license.stripe_customer_id, `${config.publicUrl}/home`);
    res.json(session);
  } catch (err) {
    sendBillingError(res, err);
  }
});

router.post('/cancel', requireSession, async (req, res) => {
  const provider = activeProvider();
  if (!provider.isConfigured()) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }

  const license = await mongoCollections.licenses.findOne({
    user_id: req.user!.id, plan: 'pro',
  });

  if (!license?.stripe_subscription_id) {
    res.status(400).json({ error: 'No active Pro subscription found' });
    return;
  }

  try {
    await provider.cancelAtPeriodEnd(license.stripe_subscription_id);
    res.json({ ok: true });
  } catch (err) {
    sendBillingError(res, err);
  }
});

function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function subscriptionItemId(sub: Stripe.Subscription): string | null {
  return sub.items.data[0]?.id ?? null;
}

// current_period_end moved from the subscription itself onto the subscription item in
// recent Stripe API versions Ã¢â‚¬â€ read the item first, fall back to the subscription.
function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const item = sub.items.data[0] as unknown as { current_period_end?: number } | undefined;
  const seconds = item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Registered separately in index.ts with express.raw() BEFORE the global JSON body
 * parser Ã¢â‚¬â€ Stripe's signature verification needs the exact raw request bytes, so this
 * route can't share the app-wide express.json() middleware the rest of the API uses.
 *
 * Every branch below maps a Stripe event onto the provider-neutral operations in
 * effects.ts, which Razorpay's handler drives too (see razorpayWebhook.ts).
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  logDebug('Stripe webhook received');
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
    if (!config.stripe.secretKey || !config.stripe.webhookSecret || !signature) {
      logWarning('Stripe webhook rejected because verification is not configured or the signature is missing');
      res.status(400).send('Webhook not configured');
      return;
    }

    const stripe = stripeClient();
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, config.stripe.webhookSecret);
    } catch (err) {
      logWarning('Stripe webhook rejected because its signature is invalid', {
        errorType: err instanceof Error ? err.name : typeof err,
      });
      res.status(400).send('Webhook signature verification failed');
      return;
    }
  }

  logDebug('Stripe webhook parsed', { eventType: event.type });
  // Stripe redelivers events on timeout/retry Ã¢â‚¬â€ process each event id at most once.
  if (!(await claimBillingEvent('stripe', event.id))) {
    logInfo('Duplicate Stripe webhook acknowledged', { eventType: event.type });
    res.json({ received: true });
    return;
  }

  try {
    await dispatchStripeEvent(event);
  } catch (err) {
    // Processing failed: release the de-duplication claim so Stripe's retry is not
    // swallowed (otherwise a transient failure here loses the activation permanently).
    await releaseBillingEvent('stripe', event.id);
    logError('Stripe webhook processing failed; event released for retry', err, { eventType: event.type });
    throw err;
  }

  logInfo('Stripe webhook processed', { eventType: event.type });
  res.json({ received: true });
}

async function dispatchStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // An individual checkout carries no metadata at all Ã¢â‚¬â€ that's what distinguishes it.
      if (session.metadata?.fk_purchase === 'org' && session.metadata.fk_org_id) {
        const subscriptionId = stripeIdOf(session.subscription);
        if (!subscriptionId) break;
        // The webhook payload's session.subscription is a bare id, so the item id, quantity
        // and period end have to be retrieved before the org can be activated.
        const subscription = await stripeClient().subscriptions.retrieve(subscriptionId);
        await activateOrgSubscription({
          provider: 'stripe',
          orgId: session.metadata.fk_org_id,
          seats: subscription.items.data[0]?.quantity ?? Number(session.metadata.fk_seats ?? '0'),
          customerId: stripeIdOf(session.customer),
          subscriptionId,
          subscriptionItemId: subscriptionItemId(subscription),
          currentPeriodEnd: subscriptionPeriodEnd(subscription),
        });
        break;
      }
      const userId = session.client_reference_id;
      if (userId) {
        await activateIndividualSubscription({
          provider: 'stripe',
          userId,
          customerId: stripeIdOf(session.customer),
          subscriptionId: stripeIdOf(session.subscription),
        });
      }
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const status = subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : 'inactive';
      await setSubscriptionStatus(subscription.id, status);
      // No-op when this subscription isn't a Team's Ã¢â‚¬â€ reconciles seats_purchased (and the
      // pool's grant) if it drifted, e.g. a change made directly in the Stripe dashboard.
      await syncSeatsForSubscription(subscription.id, subscription.items.data[0]?.quantity);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await endSubscription(subscription.id);
      break;
    }
    case 'invoice.paid': {
      // Credits reset every billing cycle for both individual Pro and Team pools.
      const invoice = event.data.object as Stripe.Invoice;
      // Recent Stripe API versions moved the subscription reference off the invoice
      // itself and onto invoice.parent.subscription_details.subscription.
      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
      if (invoice.billing_reason === 'subscription_cycle' && subscriptionId) {
        await renewSubscriptionQuota(subscriptionId);
      }
      break;
    }
    default:
      break;
  }
}
