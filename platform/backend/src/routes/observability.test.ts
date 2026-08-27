import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'express-async-errors';
import { observabilityService } from '../services/observabilityService.js';
import { buildTestApp, makeTestAuthUser, makeTestSession } from '../testUtils/testApp.js';

const { observabilityRouter } = await import('./observability.js');

function app() {
  return buildTestApp('/api/observability', observabilityRouter, { authUser: makeTestAuthUser() });
}

/** A minimal, real kubeconfig with token auth (no exec plugin) so ensureContextAuthReady
 * succeeds without needing Azure/kubelogin. */
function writeTempKubeconfig(contextName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focuskube-test-'));
  const kubeconfigPath = path.join(dir, 'config');
  fs.writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: test-cluster',
      '  cluster:',
      '    server: https://example.invalid',
      'contexts:',
      `- name: ${contextName}`,
      '  context:',
      '    cluster: test-cluster',
      '    user: test-user',
      `current-context: ${contextName}`,
      'users:',
      '- name: test-user',
      '  user:',
      '    token: fake-token',
      '',
    ].join('\n'),
    'utf8',
  );
  return kubeconfigPath;
}


test('GET /debug/recordings reports when no lifecycle instance exists', async (t) => {
  t.mock.method(observabilityService, 'getLifecycleInstance', () => null);

  const res = await request(app()).get('/api/observability/debug/recordings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { error: 'No lifecycle instance' });
});

test('GET /status reports unavailable in desktop mode', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => false);

  const res = await request(app()).get('/api/observability/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { available: false, reason: 'desktop-mode', recording: null });
});

test('GET /status returns recording status when available', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'getStatus', async () => ({ recording: true }));

  const res = await request(app()).get('/api/observability/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { available: true, recording: { recording: true } });
});

test('POST /recordings/start returns 503 when unavailable', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => false);

  const res = await request(app()).post('/api/observability/recordings/start').send({ context: 'ctx-1' });
  assert.equal(res.status, 503);
});

test('POST /recordings/start requires a context', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);

  const res = await request(app()).post('/api/observability/recordings/start').send({});
  assert.equal(res.status, 400);
});

test('POST /recordings/start starts a recording', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'startRecording', async () => ({ recordingId: 'rec-1' }));

  const kubeconfigPath = writeTempKubeconfig('ctx-1');
  const session = makeTestSession({
    activeContext: 'ctx-1',
    activeContextSource: 'azure',
    cloudKubeconfigPath: kubeconfigPath,
  });
  const scopedApp = buildTestApp('/api/observability', observabilityRouter, {
    authUser: makeTestAuthUser(),
    session,
  });

  const res = await request(scopedApp).post('/api/observability/recordings/start').send({ context: 'ctx-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { recordingId: 'rec-1' });
});

test('POST /recordings/stop stops a recording', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'stopRecording', async () => undefined);

  const res = await request(app()).post('/api/observability/recordings/stop').send({ context: 'ctx-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'stopped', context: 'ctx-1', userId: 'test-user' });
});

test('GET /events requires a context', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);

  const res = await request(app()).get('/api/observability/events');
  assert.equal(res.status, 400);
});

test('GET /events returns queried events', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'queryEvents', async () => ({ events: [] }));

  const res = await request(app()).get('/api/observability/events?context=ctx-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { events: [] });
});

test('GET /state-at returns queried state', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'queryStateAt', async () => ({ pods: [] }));

  const res = await request(app()).get('/api/observability/state-at?context=ctx-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { pods: [] });
});

test('GET /correlation returns correlated results', async (t) => {
  t.mock.method(observabilityService, 'isAvailable', () => true);
  t.mock.method(observabilityService, 'correlate', async () => ({ correlated: [] }));

  const res = await request(app()).get('/api/observability/correlation?context=ctx-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { correlated: [] });
});

