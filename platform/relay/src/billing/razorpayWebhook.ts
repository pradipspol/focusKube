/**
 * Razorpay webhook receiver. Mounted in index.ts with express.raw() BEFORE the app-wide JSON
 * parser — the signature is an HMAC over the exact raw request bytes, so a re-serialised body
 * would not verify.
 *
 * Every event is translated into the provider-neutral operations in billing/effects.ts, which
 * is where the actual license/org state changes live (shared with the Stripe handler).
 *
 * Docs: https://razorpay.com/docs/webhooks/validate-test/
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import {
  activateIndividualSubscription,
  activateOrgSubscription,
  claimBillingEvent,
  endSubscription,
  releaseBillingEvent,
  renewSubscriptionQuota,
  setSubscriptionStatus,
  syncSeatsForSubscription,
} from './effects.js';
import type { RazorpaySubscription } from './razorpay.js';

interface RazorpayWebhookBody {
  event?: string;
  payload?: { subscription?: { entity?: RazorpaySubscription } };
}

/** HMAC-SHA256 over the raw body, keyed by the webhook secret (which is NOT the API key
 * secret). Compared in constant time so the check can't be probed byte by byte. */
function signatureIsValid(rawBody: Buffer, signature: string): boolean {
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function seatsOf(subscription: RazorpaySubscription): number {
  if (typeof subscription.quantity === 'number' && subscription.quantity > 0) return subscription.quantity;
  const fromNotes = Number(subscription.notes?.fk_seats);
  return Number.isFinite(fromNotes) && fromNotes > 0 ? fromNotes : 1;
}

function periodEndOf(subscription: RazorpaySubscription): string | null {
  return typeof subscription.current_end === 'number' ? new Date(subscription.current_end * 1000).toISOString() : null;
}

export async function handleRazorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body as Buffer;

  if (!config.razorpay.webhookSecret || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) {
    res.status(400).send('Webhook not configured');
    return;
  }
  if (!signatureIsValid(rawBody, signature)) {
    res.status(400).send('Webhook signature verification failed');
    return;
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookBody;
  } catch {
    res.status(400).send('Invalid JSON body');
    return;
  }

  // Razorpay redelivers on timeout/retry; x-razorpay-event-id is unique per event. If that
  // header is ever absent, fall back to a hash of the body rather than skipping de-duplication
  // altogether — a redelivered charge would otherwise refill the customer's quota again.
  const headerEventId = req.headers['x-razorpay-event-id'];
  const eventId =
    typeof headerEventId === 'string' && headerEventId
      ? headerEventId
      : `body:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
  if (!claimBillingEvent('razorpay', eventId)) {
    res.json({ received: true });
    return;
  }

  const subscription = body.payload?.subscription?.entity;
  if (!subscription?.id) {
    res.json({ received: true });
    return;
  }

  try {
    dispatch(body.event, subscription);
  } catch (err) {
    // Processing failed: give up the de-duplication claim so Razorpay's retry is not
    // swallowed, then let the error surface (express-async-errors turns it into a 500,
    // which is what tells Razorpay to retry).
    releaseBillingEvent('razorpay', eventId);
    throw err;
  }

  res.json({ received: true });
}

function dispatch(event: string | undefined, subscription: RazorpaySubscription): void {
  switch (event) {
    case 'subscription.activated': {
      // Stripe's checkout.session.completed equivalent. Which flow this is comes from the
      // notes we set at creation — Razorpay has no client_reference_id/metadata otherwise.
      const notes = subscription.notes ?? {};
      if (notes.fk_purchase === 'org' && notes.fk_org_id) {
        activateOrgSubscription({
          provider: 'razorpay',
          orgId: notes.fk_org_id,
          seats: seatsOf(subscription),
          customerId: subscription.customer_id ?? null,
          subscriptionId: subscription.id,
          // Razorpay has no subscription-item concept; quantity lives on the subscription.
          subscriptionItemId: null,
          currentPeriodEnd: periodEndOf(subscription),
        });
      } else if (notes.fk_user_id) {
        activateIndividualSubscription({
          provider: 'razorpay',
          userId: notes.fk_user_id,
          customerId: subscription.customer_id ?? null,
          subscriptionId: subscription.id,
        });
      }
      break;
    }

    case 'subscription.charged': {
      // Fires for the FIRST payment as well as renewals, so the event type alone can't tell
      // them apart — paid_count does. The first charge's credits were already granted by
      // subscription.activated; only later cycles refill.
      if ((subscription.paid_count ?? 1) > 1) {
        renewSubscriptionQuota(subscription.id);
      }
      break;
    }

    case 'subscription.updated': {
      syncSeatsForSubscription(subscription.id, subscription.quantity);
      break;
    }

    case 'subscription.pending':
    case 'subscription.paused':
    // 'halted' means Razorpay exhausted its payment retries. It has no Stripe analogue, but
    // it is NOT terminal — the subscription still exists and Razorpay re-activates it if a
    // payment succeeds later, so the subscription id must stay on the row for that recovery
    // (and for the Cancel button) to work.
    case 'subscription.halted': {
      // Retries running / paused / dunning exhausted: no credits until it recovers.
      setSubscriptionStatus(subscription.id, 'inactive');
      break;
    }

    case 'subscription.resumed': {
      setSubscriptionStatus(subscription.id, 'active');
      break;
    }

    case 'subscription.cancelled':
    case 'subscription.completed': {
      endSubscription(subscription.id);
      break;
    }

    default:
      break;
  }
}
