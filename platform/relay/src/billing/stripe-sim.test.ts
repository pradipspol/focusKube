import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemoCheckoutUrl } from './stripe-sim.js';

test('demo checkout URLs use the configured relay host and preserve a base path', () => {
  assert.equal(
    buildDemoCheckoutUrl('https://relay.example/focuskube/', 'cs_demo_123'),
    'https://relay.example/focuskube/demo/checkout/cs_demo_123',
  );
});