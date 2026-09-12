/**
 * Stripe simulator for development without real Stripe API keys. Simulates checkout
 * completion and subscription events by directly creating simulated webhook payloads
 * and routing them through the same handlers as real webhooks.
 */
import crypto from 'node:crypto';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { handleStripeWebhook } from './routes.js';
import type { Request, Response } from 'express';

export interface SimulatedCheckoutSession {
  id: string;
  url: string;
  mode: 'subscription';
  client_reference_id: string;
  customer_email: string;
  metadata: Record<string, string> | undefined;
  subscription: string;
  customer: string;
  success_url: string;
  cancel_url: string;
}

export interface SimulatedSubscription {
  id: string;
  status: 'active' | 'canceled';
  items: { data: Array<{ id: string; quantity: number; current_period_end: number }> };
}

// In-memory store of simulated sessions and subscriptions (cleared on restart)
const sessions = new Map<string, SimulatedCheckoutSession>();
const subscriptions = new Map<string, SimulatedSubscription>();

export function isStripeDemoMode(): boolean {
  return config.stripe.demoMode;
}

export function createDemoCheckoutSession(opts: {
  line_items: Array<{ price_data: any; quantity: number }>;
  customer_email: string;
  client_reference_id: string;
  metadata?: Record<string, string>;
  success_url: string;
  cancel_url: string;
}): SimulatedCheckoutSession {
  const sessionId = `cs_demo_${crypto.randomUUID()}`;
  const subscriptionId = `sub_demo_${crypto.randomUUID()}`;
  const customerId = `cus_demo_${crypto.randomUUID()}`;

  const session: SimulatedCheckoutSession = {
    id: sessionId,
    url: `http://localhost:4001/demo/checkout/${sessionId}`, // Fake checkout URL for testing
    mode: 'subscription',
    client_reference_id: opts.client_reference_id,
    customer_email: opts.customer_email,
    metadata: opts.metadata,
    subscription: subscriptionId,
    customer: customerId,
    success_url: opts.success_url,
    cancel_url: opts.cancel_url,
  };

  sessions.set(sessionId, session);

  // Also create the associated subscription immediately
  const subscription: SimulatedSubscription = {
    id: subscriptionId,
    status: 'active',
    items: {
      data: [
        {
          id: `si_demo_${crypto.randomUUID()}`,
          quantity: opts.line_items[0]?.quantity ?? 1,
          current_period_end: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000), // 30 days from now
        },
      ],
    },
  };

  subscriptions.set(subscriptionId, subscription);

  return session;
}

/**
 * Simulate a checkout.session.completed webhook. Normally this comes from Stripe
 * asynchronously; in demo mode we call it synchronously for immediate testing.
 */
export async function simulateCheckoutCompleted(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Simulated session not found: ${sessionId}`);

  const subscription = subscriptions.get(session.subscription);
  if (!subscription) throw new Error(`Simulated subscription not found: ${session.subscription}`);

  const event: Stripe.Event = {
    id: `evt_demo_${crypto.randomUUID()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: session.client_reference_id,
        customer_email: session.customer_email,
        customer: session.customer,
        subscription: session.subscription,
        metadata: session.metadata,
      } as unknown as object,
    },
  } as unknown as Stripe.Event;

  // Reuse the real webhook handler with a mocked request/response
  const mockReq = {
    headers: { 'stripe-signature': 'demo_sig' },
    body: event,
  } as unknown as Request;

  const mockRes = {
    status: (code: number) => ({
      send: () => {},
      json: () => {},
    }),
    json: () => {},
  } as unknown as Response;

  // Call the webhook handler directly (it doesn't actually verify the signature in demo mode)
  await handleStripeWebhook(mockReq, mockRes);
}

/**
 * Simulate a subscription status change (e.g., cancellation). Normally comes from Stripe.
 */
export async function simulateSubscriptionUpdated(
  subscriptionId: string,
  status: 'active' | 'canceled',
): Promise<void> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) throw new Error(`Simulated subscription not found: ${subscriptionId}`);

  subscription.status = status;

  const event: Stripe.Event = {
    id: `evt_demo_${crypto.randomUUID()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        status,
        items: subscription.items,
      } as unknown as Stripe.Subscription,
    },
  } as unknown as Stripe.Event;

  const mockReq = {
    headers: { 'stripe-signature': 'demo_sig' },
    body: event,
  } as unknown as Request;

  const mockRes = {
    status: (code: number) => ({
      send: () => {},
      json: () => {},
    }),
    json: () => {},
  } as unknown as Response;

  await handleStripeWebhook(mockReq, mockRes);
}

/**
 * Simulate an invoice.paid webhook (billing cycle quota reset).
 */
export async function simulateInvoicePaid(subscriptionId: string): Promise<void> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) throw new Error(`Simulated subscription not found: ${subscriptionId}`);

  const event: Stripe.Event = {
    id: `evt_demo_${crypto.randomUUID()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_demo_${crypto.randomUUID()}`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        parent: {
          subscription_details: {
            subscription: subscriptionId,
          },
        },
      } as unknown as Stripe.Invoice,
    },
  } as unknown as Stripe.Event;

  const mockReq = {
    headers: { 'stripe-signature': 'demo_sig' },
    body: event,
  } as unknown as Request;

  const mockRes = {
    status: (code: number) => ({
      send: () => {},
      json: () => {},
    }),
    json: () => {},
  } as unknown as Response;

  await handleStripeWebhook(mockReq, mockRes);
}

export function getSimulatedSession(sessionId: string): SimulatedCheckoutSession | undefined {
  return sessions.get(sessionId);
}

export function getSimulatedSubscription(subscriptionId: string): SimulatedSubscription | undefined {
  return subscriptions.get(subscriptionId);
}

export function listSimulatedSessions(): SimulatedCheckoutSession[] {
  return Array.from(sessions.values());
}

export function listSimulatedSubscriptions(): SimulatedSubscription[] {
  return Array.from(subscriptions.values());
}
