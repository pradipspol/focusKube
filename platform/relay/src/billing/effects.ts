/**
 * Provider-neutral billing effects: everything a payment webhook does to our own state.
 *
 * Stripe and Razorpay send completely different event shapes, but they mean the same few
 * things to us. Each provider's webhook handler translates its payload into plain data and
 * calls in here, so the money-state logic (issue a license, activate a Team pool, reset a
 * cycle's quota, deactivate) exists exactly once rather than once per provider.
 *
 * Persistence itself still lives in licenseStore.ts / org/store.ts — this module only
 * sequences those existing operations.
 */
import { config } from '../config.js';
import { db } from '../db.js';
import { logDebug, logInfo } from '../logger.js';
import {
  adjustOrgPoolForSeatChange,
  createLicenseForUser,
  createOrgPoolLicense,
  resetQuotaForSubscription,
} from '../licenseStore.js';
import {
  activateOrg,
  findOrgById,
  findOrgBySubscriptionId,
  seatUser,
  setOrgSeatsPurchased,
  setOrgStatus,
} from '../org/store.js';

export type BillingProviderName = 'stripe' | 'razorpay';

const PAID_PLAN = 'pro';

/** A paid individual subscription just went live: issue the Pro license and record which
 * provider's subscription backs it.
 *
 * Idempotent for a subscription we already know about. Razorpay re-sends
 * subscription.activated whenever a subscription returns to active (notably after failed
 * payments are recovered from 'halted'), and re-running the issue path would mint a BRAND
 * NEW license key — silently invalidating the key already installed in the customer's
 * desktop app — while also handing out a free mid-cycle quota refill. */
export function activateIndividualSubscription(args: {
  provider: BillingProviderName;
  userId: string;
  customerId: string | null;
  subscriptionId: string | null;
}): void {
  logDebug('Activating individual billing subscription', {
    provider: args.provider,
    userId: args.userId,
    hasSubscription: !!args.subscriptionId,
  });
  const existing = db.prepare(`SELECT stripe_subscription_id FROM licenses WHERE user_id = ?`).get(args.userId) as
    | { stripe_subscription_id: string | null }
    | undefined;

  if (args.subscriptionId && existing?.stripe_subscription_id === args.subscriptionId) {
    db.prepare(`UPDATE licenses SET status = 'active', updated_at = ? WHERE user_id = ?`).run(
      new Date().toISOString(),
      args.userId,
    );
    logInfo('Individual billing subscription reactivated', { provider: args.provider, userId: args.userId });
    return;
  }

  createLicenseForUser(args.userId, { plan: PAID_PLAN, quotaRemaining: config.pricing.proQuota });
  db.prepare(
    `UPDATE licenses SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_provider = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(args.customerId, args.subscriptionId, args.provider, new Date().toISOString(), args.userId);
  logInfo('Individual billing subscription activated', { provider: args.provider, userId: args.userId });
}

/** A paid Team subscription just went live: activate the org, create its pooled license and
 * seat the owner, in one transaction. `subscriptionItemId` is Stripe-only (Razorpay carries
 * quantity on the subscription itself and passes null). */
export function activateOrgSubscription(args: {
  provider: BillingProviderName;
  orgId: string;
  seats: number;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionItemId: string | null;
  currentPeriodEnd: string | null;
}): void {
  logDebug('Activating organization billing subscription', {
    provider: args.provider,
    orgId: args.orgId,
    seats: args.seats,
  });
  const org = findOrgById(args.orgId);
  if (!org) {
    logInfo('Organization billing activation skipped because the organization does not exist', { orgId: args.orgId });
    return;
  }

  // Same re-activation guard as the individual path above: re-running this would rotate
  // both the pooled license key and the owner's seat key, and re-grant the pool's credits.
  const existingPool = db.prepare(`SELECT stripe_subscription_id FROM licenses WHERE org_id = ?`).get(args.orgId) as
    | { stripe_subscription_id: string | null }
    | undefined;
  if (args.subscriptionId && existingPool?.stripe_subscription_id === args.subscriptionId) {
    db.transaction(() => {
      db.prepare(`UPDATE licenses SET status = 'active', updated_at = ? WHERE org_id = ?`).run(
        new Date().toISOString(),
        args.orgId,
      );
      setOrgStatus(org.id, 'active');
    })();
    logInfo('Organization billing subscription reactivated', { provider: args.provider, orgId: args.orgId });
    return;
  }

  db.transaction(() => {
    activateOrg(org.id, args.seats);
    createOrgPoolLicense(org.id, {
      seats: args.seats,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      subscriptionItemId: args.subscriptionItemId,
      currentPeriodEnd: args.currentPeriodEnd,
    });
    db.prepare(`UPDATE licenses SET billing_provider = ?, updated_at = ? WHERE org_id = ?`).run(
      args.provider,
      new Date().toISOString(),
      org.id,
    );
    seatUser(org.id, org.owner_user_id, 'owner', null);
  })();
  logInfo('Organization billing subscription activated', { provider: args.provider, orgId: args.orgId, seats: args.seats });
}

/** Subscription still exists but changed state (paused, payment retries pending, reactivated).
 * Mirrors onto the org row for a Team subscription, so /team can't show an active team whose
 * pooled credits are actually suspended. */
export function setSubscriptionStatus(subscriptionId: string, status: 'active' | 'inactive'): void {
  logDebug('Updating billing subscription status', { status });
  const org = findOrgBySubscriptionId(subscriptionId);
  db.prepare(`UPDATE licenses SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?`).run(
    status,
    new Date().toISOString(),
    subscriptionId,
  );
  if (org) setOrgStatus(org.id, status);
  logInfo('Billing subscription status updated', { status, organizationSubscription: !!org });
}

/** Seat-count drift reconciliation — a no-op unless this subscription belongs to a Team.
 * Adjusts the pool by the seat *delta* so a mid-cycle change doesn't hand out a free refill. */
export function syncSeatsForSubscription(subscriptionId: string, seats: number | null | undefined): void {
  const org = findOrgBySubscriptionId(subscriptionId);
  if (!org) {
    logDebug('Billing seat synchronization skipped for an individual subscription');
    return;
  }
  const newSeats = seats ?? org.seats_purchased;
  if (newSeats === org.seats_purchased) {
    logDebug('Billing seat synchronization found no change', { orgId: org.id, seats: newSeats });
    return;
  }
  logDebug('Synchronizing organization seats from billing provider', { orgId: org.id, seats: newSeats });
  adjustOrgPoolForSeatChange(org.id, org.seats_purchased, newSeats);
  setOrgSeatsPurchased(org.id, newSeats);
  logInfo('Organization seats synchronized from billing provider', { orgId: org.id, seats: newSeats });
}

/** The subscription is gone for good (cancelled, completed, or dunning exhausted).
 *
 * Also clears stripe_subscription_id: the subscription no longer exists at the provider, so
 * leaving the id on the row lets a stale "Cancel subscription" button call the provider's
 * cancel API on a dead id and throw, instead of a clean "nothing to cancel". */
export function endSubscription(subscriptionId: string): void {
  logDebug('Ending billing subscription');
  const org = findOrgBySubscriptionId(subscriptionId);
  db.prepare(
    `UPDATE licenses SET status = 'inactive', stripe_subscription_id = NULL, updated_at = ?
     WHERE stripe_subscription_id = ?`,
  ).run(new Date().toISOString(), subscriptionId);
  if (org) setOrgStatus(org.id, 'cancelled');
  logInfo('Billing subscription ended', { organizationSubscription: !!org, orgId: org?.id ?? null });
}

/** A new billing cycle was paid for — refill the cycle's credits. */
export function renewSubscriptionQuota(subscriptionId: string): void {
  logDebug('Renewing billing subscription quota');
  resetQuotaForSubscription(subscriptionId);
  logInfo('Billing subscription quota renewal completed');
}

/** Webhook de-duplication shared by both providers (see db.ts's billing_events table).
 * Returns true the first time an event id is seen, false on a redelivery.
 *
 * Stripe's pre-existing stripe_events table is still consulted for Stripe events: an event
 * already processed before this deploy must not re-apply when Stripe retries it (its retry
 * window is days long, and a replayed invoice.paid would hand out a free quota refill).
 *
 * The claim is provisional — callers must releaseBillingEvent() if processing then fails,
 * otherwise the provider's retry is silently swallowed and the activation is lost. */
export function claimBillingEvent(provider: BillingProviderName, eventId: string): boolean {
  logDebug('Claiming billing webhook event', { provider });
  const id = `${provider}:${eventId}`;
  if (db.prepare(`SELECT id FROM billing_events WHERE id = ?`).get(id)) {
    logInfo('Duplicate billing webhook event detected', { provider });
    return false;
  }
  if (provider === 'stripe' && db.prepare(`SELECT id FROM stripe_events WHERE id = ?`).get(eventId)) {
    logInfo('Previously processed Stripe webhook event detected', { provider });
    return false;
  }
  db.prepare(`INSERT INTO billing_events (id, provider, processed_at) VALUES (?, ?, ?)`).run(
    id,
    provider,
    new Date().toISOString(),
  );
  logInfo('Billing webhook event claimed', { provider });
  return true;
}

/** Undoes claimBillingEvent so a failed event can be retried by the provider. */
export function releaseBillingEvent(provider: BillingProviderName, eventId: string): void {
  logDebug('Releasing billing webhook event claim', { provider });
  db.prepare(`DELETE FROM billing_events WHERE id = ?`).run(`${provider}:${eventId}`);
  logInfo('Billing webhook event claim released', { provider });
}
