import { config } from '../config.js';

export type BillingCurrency = 'usd' | 'inr';

/** The currency the active provider bills in. Prices are authored in USD; Razorpay (India)
 * accounts bill INR unless international payments are enabled on the account. */
export function activeCurrency(): BillingCurrency {
  return config.billing.provider === 'razorpay' ? 'inr' : 'usd';
}

/** The Pro plan's per-seat monthly-equivalent price, in cents, for a given billing
 * interval — annual applies config.pricing.annualDiscountPercent off twelve months. */
export function proUnitAmountCents(interval: 'month' | 'year'): number {
  const monthly = config.pricing.proPriceMonthlyCents;
  return interval === 'month' ? monthly : Math.round(monthly * 12 * (1 - config.pricing.annualDiscountPercent / 100));
}

/** The same price in the given currency's minor unit (cents / paise). INR is the USD figure
 * times config.pricing.usdToInrRate — a configured multiple, not a live FX rate, because a
 * Razorpay Plan's amount is immutable (see the config comment). At the default rate of 100,
 * $19.99/mo (1999 cents) becomes ₹1999/mo (199900 paise). */
export function proUnitAmountMinor(interval: 'month' | 'year', currency: BillingCurrency = activeCurrency()): number {
  const cents = proUnitAmountCents(interval);
  return currency === 'inr' ? cents * config.pricing.usdToInrRate : cents;
}

/** Display string for an amount in a currency's minor unit. INR is shown without decimals
 * (₹1999, not ₹1999.00) since the configured rate always lands on whole rupees. */
export function formatPrice(minorUnits: number, currency: BillingCurrency = activeCurrency()): string {
  return currency === 'inr' ? `₹${Math.round(minorUnits / 100)}` : `$${(minorUnits / 100).toFixed(2)}`;
}

/** Formatted per-month price for an interval — annual is shown as its monthly equivalent,
 * which is how both the landing and home pages present it. */
export function formatProMonthlyEquivalent(interval: 'month' | 'year'): string {
  const perMonthMinor = interval === 'month' ? proUnitAmountMinor('month') : Math.round(proUnitAmountMinor('year') / 12);
  return formatPrice(perMonthMinor);
}

/** One Stripe Checkout line item for N seats of Pro at the given interval. Uses inline
 * price_data (not a pre-created Stripe Price ID) so the price is entirely config-driven —
 * changing PRO_PRICE_MONTHLY_CENTS or PRO_ANNUAL_DISCOUNT_PERCENT takes effect on the next
 * checkout with no Stripe dashboard change. A later seat-count change still works (see
 * org/billing.ts's updateOrgSeats) since Stripe attaches whatever price was used at
 * creation to the subscription item regardless of whether it came from price_data or a
 * catalog Price — only quantity needs to change.
 *
 * Stripe-only: Razorpay has no inline price and needs a pre-created Plan object instead
 * (see billing/razorpay.ts's findOrCreatePlan). */
export function buildProLineItem(interval: 'month' | 'year', quantity: number) {
  return {
    price_data: {
      currency: 'usd',
      product_data: { name: 'FocusKube Pro', description: 'AI assistant access for FocusKube' },
      unit_amount: proUnitAmountCents(interval),
      recurring: { interval },
    },
    quantity,
  };
}

export function parseInterval(value: unknown): 'month' | 'year' {
  return value === 'year' ? 'year' : 'month';
}
