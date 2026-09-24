/**
 * Stripe behind the BillingProvider interface. This is the existing Stripe behaviour lifted
 * out of billing/routes.ts and org/billing.ts unchanged — including demo mode, which stays
 * Stripe-only (it's a dev convenience, not a customer-facing path).
 */
import { config } from '../config.js';
import { BillingConfigError, type BillingProvider, type CheckoutRequest, type CheckoutResult } from './provider.js';
import { buildProLineItem } from './pricing.js';
import { isStripeConfigured, stripeClient } from './stripe.js';
import { createDemoCheckoutSession, isStripeDemoMode } from './stripe-sim.js';

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

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
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
      return {
        url: demoSession.url,
        demo: true,
        sessionId: demoSession.id,
        note: 'Demo mode: call POST /v1/dev/stripe/webhook/checkout-completed with sessionId to simulate completion',
      };
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
    return { url: session.url };
  },

  async createPortalSession(customerId: string, returnUrl: string) {
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    const stripe = stripeClient();
    const portalSession = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { url: portalSession.url };
  },

  async cancelAtPeriodEnd(subscriptionId: string) {
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    const stripe = stripeClient();
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  },

  async updateSeats({ subscriptionId, subscriptionItemId, seats }) {
    if (!isStripeConfigured()) throw new BillingConfigError('Billing is not configured on this server');
    if (!subscriptionItemId) throw new Error('This subscription has no item to update');
    const stripe = stripeClient();
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: subscriptionItemId, quantity: seats }],
      proration_behavior: 'create_prorations',
    });
  },
};
