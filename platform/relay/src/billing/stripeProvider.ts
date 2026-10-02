/**
 * Stripe behind the BillingProvider interface. This is the existing Stripe behaviour lifted
 * out of billing/routes.ts and org/billing.ts unchanged — including demo mode, which stays
 * Stripe-only (it's a dev convenience, not a customer-facing path).
 */
import { config } from '../config.js';
import { BillingConfigError, type BillingProvider, type CheckoutRequest, type CheckoutResult } from './provider.js';
import { buildProLineItem, proUnitAmountCents } from './pricing.js';
import { isStripeConfigured, stripeClient } from './stripe.js';
import { createDemoCheckoutSession, getSimulatedSubscription, isStripeDemoMode, updateSimulatedSubscriptionInterval, updateSimulatedSubscriptionSeats } from './stripe-sim.js';
import { logDebug, logInfo } from '../logger.js';

function successUrl(purpose: 'individual' | 'org'): string {
  return purpose === 'org' ? `${config.publicUrl}/team?checkout=success` : `${config.publicUrl}/home?checkout=success`;
}

function cancelUrl(purpose: 'individual' | 'org'): string {
  return purpose === 'org'
    ? `${config.publicUrl}/team?checkout=cancelled`
    : `${config.publicUrl}/home?checkout=cancelled`;
}

/** Only an org purchase carries metadata — an individual checkout has none at all, which is
 * exactly what the webhook branches on. */
function checkoutMetadata(request: CheckoutRequest): Record<string, string> | undefined {
  if (request.purpose !== 'org' || !request.orgId) return undefined;
  return { fk_purchase: 'org', fk_org_id: request.orgId, fk_seats: String(request.quantity) };
}

export const stripeProvider: BillingProvider = {
  name: 'stripe',

  /** True in demo mode too — demo simulates *checkout*. Portal and cancel still need real
   * credentials, so those two guard separately below. */
  isConfigured() {
    return isStripeConfigured() || isStripeDemoMode();
  },

  supportsPortal() {
    return true;
  },

  supportsAnnualUpgrade() {
    return true;
  },

  async getSubscriptionInterval({ subscriptionId, subscriptionItemId }) {
    if (isStripeDemoMode() && subscriptionId.startsWith('sub_demo_')) {
      const item = getSimulatedSubscription(subscriptionId)?.items.data.find((candidate) => candidate.id === subscriptionItemId);
      return item?.price.recurring.interval ?? null;
    }
    if (!isStripeConfigured() || !subscriptionItemId) return null;
    const subscription = await stripeClient().subscriptions.retrieve(subscriptionId);
    const interval: string | undefined = subscription.items.data.find((candidate) => candidate.id === subscriptionItemId)?.price.recurring?.interval;
    return interval === 'month' || interval === 'year' ? interval : null;
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    logDebug('Creating Stripe checkout session', {
      purpose: request.purpose,
      interval: request.interval,
      quantity: request.quantity,
      demoMode: isStripeDemoMode(),
    });
    const metadata = checkoutMetadata(request);
    const lineItems = [buildProLineItem(request.interval, request.quantity)];

    if (isStripeDemoMode()) {
      const demoSession = createDemoCheckoutSession({
        line_items: lineItems,
        customer_email: request.user.email || 'test@example.com',
        client_reference_id: request.user.id,
        metadata,
        success_url: successUrl(request.purpose),
        cancel_url: cancelUrl(request.purpose),
      });
      const result = {
        url: demoSession.url,
        demo: true,
        sessionId: demoSession.id,
        note: 'Demo mode: call POST /v1/dev/stripe/webhook/checkout-completed with sessionId to simulate completion',
      };
      logInfo('Stripe demo checkout session created', { purpose: request.purpose, quantity: request.quantity });
      return result;
    }

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: lineItems,
      customer_email: request.user.email ?? undefined,
      client_reference_id: request.user.id,
      ...(metadata ? { metadata, subscription_data: { metadata } } : {}),
      success_url: successUrl(request.purpose),
      cancel_url: cancelUrl(request.purpose),
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    logInfo('Stripe checkout session created', { purpose: request.purpose, quantity: request.quantity });
    return { url: session.url };
  },

  async createPortalSession(customerId: string, returnUrl: string) {
    logDebug('Creating Stripe billing portal session');
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    const stripe = stripeClient();
    const portalSession = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    logInfo('Stripe billing portal session created');
    return { url: portalSession.url };
  },

  async cancelAtPeriodEnd(subscriptionId: string) {
    logDebug('Scheduling Stripe subscription cancellation');
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    const stripe = stripeClient();
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    logInfo('Stripe subscription cancellation scheduled');
  },

  async updateSeats({ subscriptionId, subscriptionItemId, seats }) {
    logDebug('Updating Stripe subscription seats', { seats });
    if (isStripeDemoMode() && subscriptionId.startsWith('sub_demo_')) {
      if (!subscriptionItemId || !updateSimulatedSubscriptionSeats(subscriptionId, subscriptionItemId, seats)) {
        throw new Error('The simulated team subscription could not be found');
      }
      logInfo('Stripe demo subscription seats updated', { seats });
      return;
    }
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    if (!subscriptionItemId) throw new Error('This subscription has no item to update');
    const stripe = stripeClient();
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: subscriptionItemId, quantity: seats }],
      proration_behavior: 'create_prorations',
    });
    logInfo('Stripe subscription seats updated', { seats });
  },

  async updateInterval({ subscriptionId, subscriptionItemId, interval }) {
    logDebug('Updating Stripe subscription billing interval', { interval });
    if (isStripeDemoMode() && subscriptionId.startsWith('sub_demo_')) {
      if (!subscriptionItemId || !updateSimulatedSubscriptionInterval(subscriptionId, subscriptionItemId, interval)) {
        throw new Error('The simulated team subscription could not be found');
      }
      logInfo('Stripe demo subscription billing interval updated', { interval });
      return;
    }
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    if (!subscriptionItemId) throw new Error('This subscription has no item to update');
    const stripe = stripeClient();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data.find((candidate) => candidate.id === subscriptionItemId);
    if (!item) throw new Error('This subscription item could not be found');
    const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
    await stripe.subscriptions.update(subscriptionId, {
      items: [{
        id: subscriptionItemId,
        price_data: {
          currency: 'usd',
          product: productId,
          unit_amount: proUnitAmountCents(interval),
          recurring: { interval },
        },
      }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    });
    logInfo('Stripe subscription billing interval updated', { interval });
  },
};
