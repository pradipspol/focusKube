import test from 'node:test';
import assert from 'node:assert/strict';
import { persistOrgSubscriptionActivation } from './effects.js';

test('organization activation writes its pool and owner seat before marking the org active', async () => {
  const operations: string[] = [];
  const repositories = {
    licenses: {
      findOne: async () => null,
      updateOne: async () => { operations.push('license'); },
    },
    organization_members: {
      findOne: async () => null,
      updateOne: async () => { operations.push('owner seat'); },
    },
    organizations: {
      updateOne: async () => { operations.push('organization active'); },
    },
  } as unknown as Parameters<typeof persistOrgSubscriptionActivation>[0];

  await persistOrgSubscriptionActivation(repositories, {
    id: 'org-1',
    name: 'Test team',
    owner_user_id: 'user-1',
    status: 'pending',
    seats_purchased: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, {
    provider: 'stripe',
    orgId: 'org-1',
    seats: 3,
    customerId: 'cus_demo',
    subscriptionId: 'sub_demo',
    subscriptionItemId: 'si_demo',
    currentPeriodEnd: null,
    billingInterval: 'month',
  });

  assert.deepEqual(operations, ['license', 'owner seat', 'organization active']);
});