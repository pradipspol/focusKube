import { config } from '../config.js';

/** The Pro plan's per-seat monthly-equivalent price, in cents, for a given billing
 * interval — annual applies config.pricing.annualDiscountPercent off twelve months. */
export function proUnitAmountCents(interval: 'month' | 'year'): number {
  const monthly = config.pricing.proPriceMonthlyCents;
  return interval === 'month' ? monthly : Math.round(monthly * 12 * (1 - config.pricing.annualDiscountPercent / 100));
}

/** One Stripe Checkout line item for N seats of Pro at the given interval. Uses inline
 * price_data (not a pre-created Stripe Price ID) so the price is entirely config-driven —
 * changing PRO_PRICE_MONTHLY_CENTS or PRO_ANNUAL_DISCOUNT_PERCENT takes effect on the next
 * checkout with no Stripe dashboard change. A later seat-count change still works (see
 * org/billing.ts's updateOrgSeats) since Stripe attaches whatever price was used at
 * creation to the subscription item regardless of whether it came from price_data or a
 * catalog Price — only quantity needs to change. */
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
