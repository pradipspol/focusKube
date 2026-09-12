import type Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db.js';
import { stripeClient } from '../billing/stripe.js';
import { buildProLineItem } from '../billing/pricing.js';
import { adjustOrgPoolForSeatChange, createOrgPoolLicense, getLicenseForUser } from '../licenseStore.js';
import { isStripeDemoMode, createDemoCheckoutSession } from '../billing/stripe-sim.js';
import type { SessionUser } from '../auth/sessions.js';
import { OrgActionError } from './errors.js';
import {
  activateOrg,
  createPendingOrg,
  findOrgById,
  findOrgByOwner,
  findOrgBySubscriptionId,
  seatCounts,
  seatUser,
  setOrgSeatsPurchased,
  setOrgStatus,
} from './store.js';

/** Creates (or reuses, if checkout was abandoned last time) the org row and starts a Stripe
 * Checkout session for N seats of Pro. The org row is created *before* redirecting to
 * Stripe — client_reference_id keeps meaning "the buying user" (unchanged from the
 * individual flow); the org identity rides in `metadata` instead, so an individual
 * checkout (no such metadata) takes the existing, untouched webhook path. */
export async function createOrgCheckoutSession(
  user: SessionUser,
  opts: { seats: number; name: string; interval: 'month' | 'year' },
): Promise<{ url: string }> {
  // Individual Pro (trial or paid) cannot create team plans — only Free users can buy a team.
  const personalLicense = getLicenseForUser(user.id);
  if (personalLicense && (personalLicense.plan === 'pro' || personalLicense.plan === 'trial') && personalLicense.status === 'active') {
    throw new OrgActionError(409, `You already have an active ${personalLicense.plan === 'trial' ? 'trial' : 'Pro'} plan. Leave your current plan before creating a team.`);
  }

  const org = findOrgByOwner(user.id) ?? createPendingOrg(user.id, opts.name);

  if (isStripeDemoMode()) {
    // Demo mode: simulate Stripe checkout without API calls
    const demoSession = createDemoCheckoutSession({
      line_items: [buildProLineItem(opts.interval, opts.seats)],
      customer_email: user.email || 'test@example.com',
      client_reference_id: user.id,
      metadata: { fk_purchase: 'org', fk_org_id: org.id, fk_seats: String(opts.seats) },
      success_url: `${config.publicUrl}/team?checkout=success`,
      cancel_url: `${config.publicUrl}/team?checkout=cancelled`,
    });
    return {
      url: demoSession.url,
      demo: true,
      sessionId: demoSession.id,
      note: 'Demo mode: call POST /v1/dev/stripe/webhook/checkout-completed with sessionId to simulate completion',
    } as any;
  }

  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [buildProLineItem(opts.interval, opts.seats)],
    customer_email: user.email ?? undefined,
    client_reference_id: user.id,
    metadata: { fk_purchase: 'org', fk_org_id: org.id, fk_seats: String(opts.seats) },
    subscription_data: { metadata: { fk_purchase: 'org', fk_org_id: org.id } },
    success_url: `${config.publicUrl}/team?checkout=success`,
    cancel_url: `${config.publicUrl}/team?checkout=cancelled`,
  });
  if (!session.url) throw new OrgActionError(502, 'Stripe did not return a checkout URL');
  return { url: session.url };
}

function subscriptionItemId(sub: Stripe.Subscription): string | null {
  return sub.items.data[0]?.id ?? null;
}

// current_period_end moved from the subscription itself onto the subscription item in
// recent Stripe API versions — read the item first, fall back to the subscription.
function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const item = sub.items.data[0] as unknown as { current_period_end?: number } | undefined;
  const seconds = item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

/** The `checkout.session.completed` webhook's org branch (see billing/routes.ts) — retrieves
 * the subscription for its item id / quantity / period end (the webhook payload's
 * session.subscription is a bare id), then activates the org, creates the pool license,
 * and seats the owner, all in one transaction. */
export async function activateOrgFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const orgId = session.metadata?.fk_org_id;
  if (!orgId) return;
  const org = findOrgById(orgId);
  if (!org) return;

  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!subscriptionId) return;

  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const seats = subscription.items.data[0]?.quantity ?? Number(session.metadata?.fk_seats ?? '0');
  const customerId = typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);

  db.transaction(() => {
    activateOrg(org.id, seats);
    createOrgPoolLicense(org.id, {
      seats,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionItemId: subscriptionItemId(subscription),
      currentPeriodEnd: subscriptionPeriodEnd(subscription),
    });
    seatUser(org.id, org.owner_user_id, 'owner', null);
  })();
}

/** `customer.subscription.updated`'s org hook — a no-op when the subscription isn't an
 * org's. The existing status UPDATE in billing/routes.ts already handles active/inactive;
 * this only reconciles seats_purchased (and the pool's grant) if they drifted, e.g. a
 * change made directly in the Stripe dashboard rather than through updateOrgSeats below. */
export function syncOrgFromSubscription(subscription: Stripe.Subscription): void {
  const org = findOrgBySubscriptionId(subscription.id);
  if (!org) return;
  const newSeats = subscription.items.data[0]?.quantity ?? org.seats_purchased;
  if (newSeats !== org.seats_purchased) {
    adjustOrgPoolForSeatChange(org.id, org.seats_purchased, newSeats);
    setOrgSeatsPurchased(org.id, newSeats);
  }
}

/** `customer.subscription.deleted`'s org hook — a no-op when the subscription isn't an org's. */
export function markOrgCancelled(subscriptionId: string): void {
  const org = findOrgBySubscriptionId(subscriptionId);
  if (!org) return;
  setOrgStatus(org.id, 'cancelled');
}

/** Owner-triggered seat count change. Stripe's hosted Customer Portal doesn't cleanly
 * support subscription-quantity edits, so this is a custom route calling the Stripe API
 * directly. Guarded so an owner can never silently evict a seated member, and adjusts the
 * pool's grant by the seat *delta* (not a reset) so a mid-cycle change doesn't hand out a
 * free quota refill. */
export async function updateOrgSeats(orgId: string, seats: number): Promise<void> {
  const org = findOrgById(orgId);
  if (!org) throw new OrgActionError(404, 'Team not found');

  const counts = seatCounts(orgId);
  if (seats < counts.filled) {
    throw new OrgActionError(409, `Remove ${counts.filled - seats} member(s) before dropping to ${seats} seats`);
  }
  if (seats < config.org.minSeats || seats > config.org.maxSeats) {
    throw new OrgActionError(400, `Seats must be between ${config.org.minSeats} and ${config.org.maxSeats}`);
  }

  const licenseRow = db
    .prepare(`SELECT stripe_subscription_id, stripe_subscription_item_id FROM licenses WHERE org_id = ?`)
    .get(orgId) as { stripe_subscription_id: string | null; stripe_subscription_item_id: string | null } | undefined;
  if (!licenseRow?.stripe_subscription_id || !licenseRow.stripe_subscription_item_id) {
    throw new OrgActionError(400, 'This team has no active subscription to update');
  }

  const stripe = stripeClient();
  await stripe.subscriptions.update(licenseRow.stripe_subscription_id, {
    items: [{ id: licenseRow.stripe_subscription_item_id, quantity: seats }],
    proration_behavior: 'create_prorations',
  });

  adjustOrgPoolForSeatChange(orgId, org.seats_purchased, seats);
  setOrgSeatsPurchased(orgId, seats);
}
