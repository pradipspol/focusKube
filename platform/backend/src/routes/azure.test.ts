import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { buildTestApp, makeTestAuthUser, makeTestSession } from '../testUtils/testApp.js';

const realAzure = await import('../azure/azure.js');
let accountShowResult: unknown = { user: { name: 'me@example.com' } };
let subscriptionsResult: unknown[] = [];
let tenantsResult: unknown[] = [];

mock.module('../azure/azure.js', {
  namedExports: {
    ...realAzure,
    azAccountShow: async () => accountShowResult,
    azListSubscriptions: async () => subscriptionsResult,
    azListTenants: async () => tenantsResult,
    azLogout: async () => undefined,
    azListAks: async () => ({ clusters: [] }),
    azGetAksCredentials: async () => ({ contexts: [], activeContext: null }),
    invalidateAzureCliLoginCache: () => undefined,
    azSetSubscription: async () => undefined,
  },
});

const { azureRouter } = await import('./azure.js');

function app() {
  return buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/azure/account returns the signed-in account', async () => {
  accountShowResult = { user: { name: 'me@example.com' } };

  const res = await request(app()).get('/api/azure/account');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { account: { user: { name: 'me@example.com' } } });
});

test('GET /api/azure/accounts groups subscriptions by account', async () => {
  subscriptionsResult = [
    { id: 'sub-1', name: 'Sub One', isDefault: true, tenantId: 'tenant-1', user: { name: 'me@example.com' } },
  ];
  tenantsResult = [{ tenantId: 'tenant-1', displayName: 'Contoso' }];

  const res = await request(app()).get('/api/azure/accounts');
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 1);
  assert.equal(res.body.accounts[0].email, 'me@example.com');
  assert.equal(res.body.accounts[0].subscriptions[0].tenantDisplayName, 'Contoso');
});

test('GET /api/azure/subscriptions lists subscriptions', async () => {
  subscriptionsResult = [{ id: 'sub-1', name: 'Sub One' }];

  const res = await request(app()).get('/api/azure/subscriptions');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { subscriptions: [{ id: 'sub-1', name: 'Sub One' }] });
});

test('GET /api/azure/login/status returns the login manager status', async () => {
  const session = makeTestSession({ azureLoginCloud: { getStatus: () => ({ state: 'signed-in' }) } as any });
  const scopedApp = buildTestApp('/api/azure', azureRouter, { authUser: makeTestAuthUser(), session });

  const res = await request(scopedApp).get('/api/azure/login/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'signed-in' });
});
