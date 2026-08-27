import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { authRouter } from './auth.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

test('GET /api/auth/config returns desktop mode', async () => {
  const app = buildTestApp('/api/auth', authRouter, { authUser: null });
  const res = await request(app).get('/api/auth/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { mode: 'desktop' });
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

test('POST /api/auth/signout clears desktop auth state', async () => {
  const app = buildTestApp('/api/auth', authRouter, { authUser: null });
  const res = await request(app).post('/api/auth/signout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
