import { config } from '../config.js';
import { db } from '../db.js';
import { activeProvider } from '../billing/provider.js';
import { adjustOrgPoolForSeatChange, getLicenseForUser } from '../licenseStore.js';
import type { SessionUser } from '../auth/sessions.js';
import { OrgActionError } from './errors.js';
import { createPendingOrg, findOrgById, findOrgByOwner, seatCounts, setOrgSeatsPurchased } from './store.js';

/** A subscription can only be managed through the provider that created it. If a deployment
 * switches BILLING_PROVIDER while subscriptions from the old one are still live, calling the
 * new provider's API with a foreign subscription id would fail confusingly (or, worse, match
 * something unrelated) — this is what the licenses.billing_provider column is for. */
function assertProviderOwnsSubscription(rowProvider: string | null, activeName: string): void {
  if (rowProvider && rowProvider !== activeName) {
    throw new OrgActionError(
      409,
      `This subscription was created with ${rowProvider}, which is no longer this server's payment provider. Cancel it in the ${rowProvider} dashboard.`,
    );
  }
}

/**
 * Owner-facing Team billing actions. Everything here *initiates* something at the active
 * payment provider; the state changes that follow arrive over webhooks and are applied by
 * billing/effects.ts (activateOrgSubscription, syncSeatsForSubscription, endSubscription).
 */

/** Creates (or reuses, if checkout was abandoned last time) the org row and starts a checkout
 * for N seats of Pro. The org row is created *before* redirecting to the provider — its id
 * rides in provider metadata (Stripe `metadata`, Razorpay `notes`) so the activation webhook
 * can tell an org purchase from an individual one. */
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

  const result = await activeProvider().createCheckout({
    user,
    interval: opts.interval,
    quantity: opts.seats,
    purpose: 'org',
    orgId: org.id,
  });
  if (!result.url) throw new OrgActionError(502, 'The payment provider did not return a checkout URL');
  return result;
}

/** Owner-triggered seat count change. Neither provider's hosted portal edits subscription
 * quantity cleanly, so this calls the provider API directly. Guarded so an owner can never
 * silently evict a seated member, and adjusts the pool's grant by the seat *delta* (not a
 * reset) so a mid-cycle change doesn't hand out a free quota refill.
 *
 * Razorpay is materially stricter than Stripe here — it refuses quantity changes on UPI and
 * eMandate subscriptions, and outside the authenticated/active states. Those refusals are
 * deliberately allowed to propagate to the owner rather than being swallowed: the local pool
 * must not be adjusted for a seat change the provider never actually made. */
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
    .prepare(
      `SELECT stripe_subscription_id, stripe_subscription_item_id, billing_provider FROM licenses WHERE org_id = ?`,
    )
    .get(orgId) as
    | { stripe_subscription_id: string | null; stripe_subscription_item_id: string | null; billing_provider: string | null }
    | undefined;
  const provider = activeProvider();
  if (!licenseRow?.stripe_subscription_id) {
    throw new OrgActionError(400, 'This team has no active subscription to update');
  }
  // Stripe edits quantity on the subscription *item*, so without that id there is nothing to
  // update — surface the same clean 400 as a missing subscription rather than a provider error.
  if (provider.name === 'stripe' && !licenseRow.stripe_subscription_item_id) {
    throw new OrgActionError(400, 'This team has no active subscription to update');
  }
  assertProviderOwnsSubscription(licenseRow.billing_provider, provider.name);

  await provider.updateSeats({
    subscriptionId: licenseRow.stripe_subscription_id,
    subscriptionItemId: licenseRow.stripe_subscription_item_id,
    seats,
  });

  adjustOrgPoolForSeatChange(orgId, org.seats_purchased, seats);
  setOrgSeatsPurchased(orgId, seats);
}

/** Owner-triggered subscription cancellation. Marks the subscription to cancel at the
 * end of the current billing period, allowing the team to use remaining credits until then. */
export async function cancelOrgSubscription(orgId: string): Promise<void> {
  const provider = activeProvider();
  if (!provider.isConfigured()) throw new OrgActionError(503, 'Billing is not configured on this server');

  const org = findOrgById(orgId);
  if (!org) throw new OrgActionError(404, 'Team not found');

  const licenseRow = db
    .prepare(`SELECT stripe_subscription_id, billing_provider FROM licenses WHERE org_id = ?`)
    .get(orgId) as { stripe_subscription_id: string | null; billing_provider: string | null } | undefined;
  if (!licenseRow?.stripe_subscription_id) {
    throw new OrgActionError(400, 'This team has no active subscription to cancel');
  }
  assertProviderOwnsSubscription(licenseRow.billing_provider, provider.name);

  await provider.cancelAtPeriodEnd(licenseRow.stripe_subscription_id);
}
