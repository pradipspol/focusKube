/**
 * Minimal Razorpay REST client.
 *
 * Deliberately not the `razorpay` npm package: it's CommonJS-only with no `exports` map, and
 * its webhook-signature helper is a deep import (`razorpay/dist/utils/razorpay-utils`) that
 * is fragile under this package's ESM + moduleResolution:Bundler setup. We need five
 * endpoints and an HMAC check, so fetch + node:crypto is the smaller, sturdier surface.
 *
 * Docs: https://razorpay.com/docs/api/payments/subscriptions/
 */
import { config } from '../config.js';
import { mongoCollections } from '../mongoCollections.js';
import { logDebug, logInfo, logWarning } from '../logger.js';

const API_BASE = 'https://api.razorpay.com/v1';

export interface RazorpaySubscription {
  id: string;
  status: string;
  plan_id: string;
  customer_id?: string | null;
  quantity?: number;
  /** How many cycles have been paid. 1 is the activation charge; >1 is a renewal Ã¢â‚¬â€ this is
   * the only reliable way to tell them apart, since subscription.charged fires for both. */
  paid_count?: number;
  current_end?: number | null;
  short_url?: string;
  notes?: Record<string, string>;
}

/** Razorpay reports failures as { error: { code, description, ... } } with a non-2xx status.
 * Surfacing `description` matters most for seat changes, which Razorpay rejects outright for
 * UPI/eMandate subscriptions Ã¢â‚¬â€ the team owner needs to see the real reason. */
export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

/** The webhook secret counts as configuration, not an optional extra: without it every
 * webhook is rejected, so checkout would happily charge customers who could then never be
 * entitled. Better to report Razorpay as unconfigured and fall back to the trial path. */
export function isRazorpayConfigured(): boolean {
  return !!config.razorpay.keyId && !!config.razorpay.keySecret && !!config.razorpay.webhookSecret;
}

export function razorpayKeyId(): string {
  return config.razorpay.keyId;
}

function authHeader(): string {
  const token = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  return `Basic ${token}`;
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const endpoint = path.replace(/\/subscriptions\/[^/]+/, '/subscriptions/:id');
  logDebug('Calling Razorpay API', { method, endpoint });
  if (!isRazorpayConfigured()) {
    logWarning('Razorpay API call rejected because billing is not configured', { method, endpoint });
    throw new RazorpayError('Razorpay is not configured on this server', 503);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    logWarning('Razorpay API transport failed', { method, endpoint });
    throw error;
  }

  const payload = (await response.json().catch(() => ({}))) as { error?: { description?: string } };
  if (!response.ok) {
    logWarning('Razorpay API returned an error response', { method, endpoint, statusCode: response.status });
    throw new RazorpayError(payload.error?.description ?? `Razorpay request failed (${response.status})`, response.status);
  }
  logInfo('Razorpay API call completed', { method, endpoint, statusCode: response.status });
  return payload as T;
}

/**
 * Razorpay subscriptions must point at a pre-created Plan Ã¢â‚¬â€ there is no Stripe-style inline
 * price. Plans are immutable and reusable, so each (interval, currency, amount) combination
 * is created once and cached in razorpay_plans; without the cache every checkout would leave
 * another duplicate plan behind in the Razorpay dashboard.
 */
export async function findOrCreatePlan(args: {
  interval: 'month' | 'year';
  amountMinor: number;
  currency: 'INR' | 'USD';
}): Promise<string> {
  const planKey = `${args.interval}:${args.currency}:${args.amountMinor}`;
  logDebug('Resolving Razorpay billing plan', { interval: args.interval, currency: args.currency });
  const plans = mongoCollections.razorpay_plans;
  const cached = await plans.findOne({ plan_key: planKey });
  if (cached) {
    logInfo('Razorpay billing plan cache hit', { interval: args.interval, currency: args.currency });
    return cached.plan_id;
  }

  const plan = await call<{ id: string }>('POST', '/plans', {
    period: args.interval === 'year' ? 'yearly' : 'monthly',
    interval: 1,
    item: {
      name: 'FocusKube Pro',
      description: 'AI assistant access for FocusKube',
      amount: args.amountMinor,
      currency: args.currency,
    },
  });

  // Two concurrent first checkouts can both reach the create call above. INSERT OR IGNORE
  // keeps whichever landed first, and re-reading means both callers use that same plan
  // rather than diverging (the loser's plan is simply left unused at Razorpay).
  await plans.updateOne(
    { plan_key: planKey },
    { $setOnInsert: { plan_key: planKey, plan_id: plan.id, created_at: new Date().toISOString() } },
    { upsert: true },
  );
  const stored = await plans.findOne({ plan_key: planKey });
  logInfo('Razorpay billing plan created and cached', { interval: args.interval, currency: args.currency });
  return stored?.plan_id ?? plan.id;
}

/** Razorpay has no open-ended subscription: total_count (the number of billing cycles to
 * run) is required, so "forever" is ~100 years' worth of cycles. */
export async function createSubscription(args: {
  planId: string;
  interval: 'month' | 'year';
  quantity: number;
  notes: Record<string, string>;
}): Promise<RazorpaySubscription> {
  logDebug('Creating Razorpay subscription', { interval: args.interval, quantity: args.quantity });
  return call<RazorpaySubscription>('POST', '/subscriptions', {
    plan_id: args.planId,
    total_count: args.interval === 'year' ? config.razorpay.totalCountYearly : config.razorpay.totalCountMonthly,
    quantity: args.quantity,
    customer_notify: 1,
    notes: args.notes,
  });
}

/** Seat changes. Razorpay only allows this while the subscription is authenticated/active,
 * and rejects it outright for UPI and eMandate subscriptions Ã¢â‚¬â€ call sites must let the
 * resulting RazorpayError reach the user rather than reporting a success that didn't happen. */
export async function updateSubscriptionQuantity(subscriptionId: string, quantity: number): Promise<void> {
  logDebug('Updating Razorpay subscription quantity', { quantity });
  await call('PATCH', `/subscriptions/${subscriptionId}`, { quantity, schedule_change_at: 'now' });
}

export async function cancelSubscriptionAtCycleEnd(subscriptionId: string): Promise<void> {
  logDebug('Scheduling Razorpay subscription cancellation');
  await call('POST', `/subscriptions/${subscriptionId}/cancel`, { cancel_at_cycle_end: 1 });
}
