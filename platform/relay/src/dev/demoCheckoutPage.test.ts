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
    success_url: 'http://localhost:4001/home?checkout=success',
    cancel_url: 'http://localhost:4001/home?checkout=cancelled',
  }, 'test-nonce');

  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /addEventListener\('click'/);
  assert.doesNotMatch(html, /onclick=/);
});