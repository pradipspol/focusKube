import Stripe from 'stripe';
import { config } from '../config.js';

let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!config.stripe.secretKey;
}

export function stripeClient(): Stripe {
  if (!client) {
    if (!config.stripe.secretKey) throw new Error('Stripe is not configured on this server');
    client = new Stripe(config.stripe.secretKey);
  }
  return client;
}
