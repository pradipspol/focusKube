/**
 * The payment-provider seam. Exactly one provider is active per deployment, chosen by
 * BILLING_PROVIDER (see config.billing.provider) — Stripe by default.
 *
 * Everything that *initiates* something at a provider (checkout, portal, cancel, seat
 * change) goes through this interface. Everything a provider *tells us* afterwards goes the
 * other way, through billing/effects.ts. Callers (billing/routes.ts, org/billing.ts) should
 * not import a specific provider module.
 */
import type { SessionUser } from '../auth/sessions.js';
import { config } from '../config.js';
import { stripeProvider } from './stripeProvider.js';
import { razorpayProvider } from './razorpayProvider.js';

export interface CheckoutRequest {
  user: SessionUser;
  interval: 'month' | 'year';
  /** Seats. 1 for an individual Pro subscription. */
  quantity: number;
  purpose: 'individual' | 'org';
  /** Set when purpose is 'org' — rides in provider metadata so the webhook can find the org. */
  orgId?: string;
}

export interface CheckoutResult {
  /** Where to send the browser to pay. Both providers return a URL so callers (and the
   * desktop app's entitlement gate) keep the same `{ url }` response contract. */
  url: string;
  /** Present only in Stripe demo mode, which keeps its extra simulation fields. */
  demo?: boolean;
  sessionId?: string;
  note?: string;
}

/** Thrown when an operation needs real provider credentials this deployment doesn't have
 * (e.g. portal/cancel while Stripe is only in demo mode). Carries the 503 that callers
 * returned before these calls moved behind the provider interface. */
export class BillingConfigError extends Error {
  readonly status = 503;
}

export interface BillingProvider {
  readonly name: 'stripe' | 'razorpay';
  isConfigured(): boolean;
  /** Razorpay has no hosted customer portal of any kind, so the UI hides that button. */
  supportsPortal(): boolean;
  supportsAnnualUpgrade(): boolean;
  getSubscriptionInterval(args: { subscriptionId: string; subscriptionItemId: string | null }): Promise<'month' | 'year' | null>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
  updateSeats(args: { subscriptionId: string; subscriptionItemId: string | null; seats: number }): Promise<void>;
  updateInterval(args: { subscriptionId: string; subscriptionItemId: string | null; interval: 'year' }): Promise<void>;
}

export function activeProvider(): BillingProvider {
  return config.billing.provider === 'razorpay' ? razorpayProvider : stripeProvider;
}

/** Provider-agnostic replacement for the old isStripeConfigured() gates. */
export function isBillingConfigured(): boolean {
  return activeProvider().isConfigured();
}
