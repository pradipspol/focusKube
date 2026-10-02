import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDemoCheckoutPage } from './demoCheckoutPage.js';

test('demo checkout renders under the nonce CSP and binds completion without inline handlers', () => {
  const html = renderDemoCheckoutPage({
    id: 'cs_demo_123',
    url: 'http://localhost:4001/demo/checkout/cs_demo_123',
    mode: 'subscription',
    client_reference_id: 'user-1',
    customer_email: 'alice@example.com',
    metadata: undefined,
    subscription: 'sub_demo_123',
    customer: 'cus_demo_123',
    product_name: 'FocusKube Pro',
    quantity: 1,
    unit_amount: 1999,
    currency: 'usd',
    billing_interval: 'month',
    success_url: 'http://localhost:4001/home?checkout=success',
    cancel_url: 'http://localhost:4001/home?checkout=cancelled',
  }, 'test-nonce');

  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /addEventListener\('click'/);
  assert.doesNotMatch(html, /onclick=/);
});

test('demo team checkout displays the selected seats and annual total', () => {
  const html = renderDemoCheckoutPage({
    id: 'cs_demo_team',
    url: 'http://localhost:4001/demo/checkout/cs_demo_team',
    mode: 'subscription',
    client_reference_id: 'owner-1',
    customer_email: 'owner@example.com',
    metadata: { fk_purchase: 'org', fk_org_id: 'org-1', fk_seats: '4' },
    subscription: 'sub_demo_team',
    customer: 'cus_demo_team',
    product_name: 'FocusKube Pro',
    quantity: 4,
    unit_amount: 21589,
    currency: 'usd',
    billing_interval: 'year',
    success_url: 'http://localhost:4001/team?checkout=success',
    cancel_url: 'http://localhost:4001/team?checkout=cancelled',
  }, 'test-nonce');

  assert.match(html, /<strong>Seats:<\/strong> 4/);
  assert.match(html, /<strong>Plan:<\/strong> FocusKube Team/);
  assert.match(html, /Annually/);
  assert.match(html, /\$863\.56\/year/);
});