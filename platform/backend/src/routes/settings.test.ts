import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { settingsRouter } from './settings.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';
import { setLogLevel } from '../util/logger.js';

function app() {
  return buildTestApp('/api/settings', settingsRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/settings/log-level returns current level', async () => {
  setLogLevel('info');
  const res = await request(app()).get('/api/settings/log-level');
  assert.equal(res.status, 200);
  assert.equal(res.body.level, 'info');
  assert.equal(res.body.mode, 'desktop');
  assert.equal(res.body.editable, true);
});

test('POST /api/settings/log-level sets a valid level', async () => {
  const res = await request(app()).post('/api/settings/log-level').send({ level: 'debug' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, level: 'debug' });
  setLogLevel('info');
});

test('POST /api/settings/log-level rejects an invalid level', async () => {
  const res = await request(app()).post('/api/settings/log-level').send({ level: 'verbose' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid log level/i);
});

test('POST /api/settings/log-level rejects a missing level', async () => {
  const res = await request(app()).post('/api/settings/log-level').send({});
  assert.equal(res.status, 400);
});
