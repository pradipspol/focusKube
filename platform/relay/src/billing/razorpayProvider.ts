/**
 * Razorpay behind the BillingProvider interface.
 *
 * The one structural difference from Stripe: Razorpay's hosted payment page takes no
 * success_url/cancel_url, so paying there would strand the customer on Razorpay's own page.
 * Instead of returning Razorpay's `short_url`, createCheckout returns a URL to our own
 * /pay/razorpay/:subscriptionId page (see web/pay.ts), which opens Razorpay Checkout and
 * then brings the customer back to /home or /team. That keeps the `{ url }` contract every
 * existing caller — including the desktop app's entitlement gate — already expects.
 *
 * Entitlement itself is never granted by that page: webhooks remain the only source of truth.
 */
import { config } from '../config.js';
import { db } from '../db.js';
import type { BillingProvider, CheckoutRequest, CheckoutResult } from './provider.js';
import { proUnitAmountMinor } from './pricing.js';
import {
  cancelSubscriptionAtCycleEnd,
  createSubscription,
  findOrCreatePlan,
  isRazorpayConfigured,
  updateSubscriptionQuantity,
} from './razorpay.js';
import { logDebug, logInfo } from '../logger.js';

export const razorpayProvider: BillingProvider = {
  name: 'razorpay',

  isConfigured() {
    return isRazorpayConfigured();
  },

  /** Razorpay offers no hosted self-serve subscription portal at all — the UI hides the
   * "Manage billing" button and /v1/billing/portal returns 503 under this provider. */
  supportsPortal() {
    return false;
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    logDebug('Creating Razorpay checkout session', {
      purpose: request.purpose,
      interval: request.interval,
      quantity: request.quantity,
    });
    const planId = await findOrCreatePlan({
      interval: request.interval,
      amountMinor: proUnitAmountMinor(request.interval, 'inr'),
      currency: 'INR',
    });

    // Razorpay has no client_reference_id — `notes` is the only metadata channel, so the
    // buying user's id has to ride along here for the webhook to resolve the account.
    const notes: Record<string, string> = {
      fk_user_id: request.user.id,
      fk_purchase: request.purpose,
    };
    if (request.purpose === 'org' && request.orgId) {
      notes.fk_org_id = request.orgId;
      notes.fk_seats = String(request.quantity);
    }

    const subscription = await createSubscription({
      planId,
      interval: request.interval,
      quantity: request.quantity,
      notes,
    });

    // Lets /pay/razorpay/:id verify the visitor owns this subscription (see db.ts's
    // razorpay_checkouts) — there is no local license row until activation.
    db.prepare(`INSERT OR REPLACE INTO razorpay_checkouts (subscription_id, user_id, created_at) VALUES (?, ?, ?)`).run(
      subscription.id,
      request.user.id,
      new Date().toISOString(),
    );

    // returnTo decides where our payment page sends the buyer afterwards — a team
    // purchase belongs back on /team, not /home.
    const returnTo = request.purpose === 'org' ? '?returnTo=team' : '';
    logInfo('Razorpay checkout session created', { purpose: request.purpose, quantity: request.quantity });
    return { url: `${config.publicUrl}/pay/razorpay/${subscription.id}${returnTo}` };
  },

  async createPortalSession() {
    throw new Error('Razorpay has no hosted billing portal');
  },

  async cancelAtPeriodEnd(subscriptionId: string) {
    logDebug('Scheduling Razorpay subscription cancellation');
    await cancelSubscriptionAtCycleEnd(subscriptionId);
    logInfo('Razorpay subscription cancellation scheduled');
  },

  async updateSeats({ subscriptionId, seats }) {
    logDebug('Updating Razorpay subscription seats', { seats });
    // No subscription-item id here: Razorpay carries quantity on the subscription itself.
    await updateSubscriptionQuantity(subscriptionId, seats);
    logInfo('Razorpay subscription seats updated', { seats });
  },
};
