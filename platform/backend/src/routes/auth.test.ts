import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { authRouter } from './auth.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

test('GET /api/auth/config reports account mode and signed-in state', async () => {
  const signedOutApp = buildTestApp('/api/auth', authRouter, { authUser: null });
  const signedOutRes = await request(signedOutApp).get('/api/auth/config');
  assert.equal(signedOutRes.status, 200);
  assert.deepEqual(signedOutRes.body, { mode: 'account', signedIn: false });

  const authUser = makeTestAuthUser({ id: 'u1', email: 'a@b.com', role: 'admin' });
  const signedInApp = buildTestApp('/api/auth', authRouter, { authUser });
  const signedInRes = await request(signedInApp).get('/api/auth/config');
  assert.equal(signedInRes.status, 200);
  assert.deepEqual(signedInRes.body, { mode: 'account', signedIn: true });
});

test('GET /api/auth/me returns 401 when not authenticated', async () => {
  const app = buildTestApp('/api/auth', authRouter, { authUser: null });
  const res = await request(app).get('/api/auth/me');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { user: null });
});

test('GET /api/auth/me returns the current user when authenticated', async () => {
  const authUser = makeTestAuthUser({ id: 'u1', email: 'a@b.com', role: 'editor' });
  const app = buildTestApp('/api/auth', authRouter, { authUser });
  const res = await request(app).get('/api/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: { id: 'u1', email: 'a@b.com', role: 'editor' } });
});

test('POST /api/auth/signout clears the local account session', async () => {
  const app = buildTestApp('/api/auth', authRouter, { authUser: null });
  const res = await request(app).post('/api/auth/signout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
