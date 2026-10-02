import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemoCheckoutUrl, getSimulatedSubscription, updateSimulatedSubscriptionInterval, updateSimulatedSubscriptionSeats } from './stripe-sim.js';

test('demo checkout URLs use the configured relay host and preserve a base path', () => {
  assert.equal(
    buildDemoCheckoutUrl('https://relay.example/focuskube/', 'cs_demo_123'),
    'https://relay.example/focuskube/demo/checkout/cs_demo_123',
  );
});

test('demo team seat changes update or restore the simulated subscription', () => {
  const subscriptionId = 'sub_demo_test-seat-update';
  const itemId = 'si_demo_test-seat-update';

  assert.equal(updateSimulatedSubscriptionSeats(subscriptionId, itemId, 6), true);
  assert.equal(getSimulatedSubscription(subscriptionId)?.items.data[0]?.quantity, 6);
  assert.equal(updateSimulatedSubscriptionSeats(subscriptionId, itemId, 8), true);
  assert.equal(getSimulatedSubscription(subscriptionId)?.items.data[0]?.quantity, 8);
});

test('demo team subscription can be upgraded to annual billing', () => {
  const subscriptionId = 'sub_demo_test-annual-upgrade';
  const itemId = 'si_demo_test-annual-upgrade';

  assert.equal(updateSimulatedSubscriptionSeats(subscriptionId, itemId, 4), true);
  assert.equal(updateSimulatedSubscriptionInterval(subscriptionId, itemId, 'year'), true);
  assert.equal(getSimulatedSubscription(subscriptionId)?.items.data[0]?.price.recurring.interval, 'year');
});
