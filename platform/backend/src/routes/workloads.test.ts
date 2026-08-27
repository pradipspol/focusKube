import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { workloadsService } from '../services/workloadsService.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

const scoped = {
  requestedContext: 'ctx-active',
  requestedSource: undefined,
  selectedScope: 'azure' as const,
  selectedKubeconfigPath: '/tmp/cloud-kubeconfig',
  selectedAzureConfigDir: '/tmp/cloud-azure',
};

mock.module('./requestContext.js', {
  namedExports: {
    resolveScopedRequestContext: async () => scoped,
    ensureScopedContextAuth: async () => undefined,
    kubeOptionsForScope: () => ({ kubeconfigPath: scoped.selectedKubeconfigPath, fallbackContext: 'ctx-active' }),
    requestedContextFromQuery: () => undefined,
    requestedSourceFromQuery: () => undefined,
  },
});

const { workloadsRouter } = await import('./workloads.js');

function app() {
  return buildTestApp('/api/workloads', workloadsRouter, { authUser: makeTestAuthUser() });
}

test('POST /deployments/:name/restart requires namespace', async () => {
  const res = await request(app()).post('/api/workloads/deployments/web/restart');
  assert.equal(res.status, 400);
});

test('POST /deployments/:name/restart restarts a deployment', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');
  t.mock.method(workloadsService, 'restartDeployment', async () => ({ metadata: { name: 'web' } }));

  const res = await request(app()).post('/api/workloads/deployments/web/restart?namespace=default');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { metadata: { name: 'web' } });
});

test('POST /deployments/:name/scale requires a valid replicas body', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');

  const res = await request(app()).post('/api/workloads/deployments/web/scale?namespace=default').send({ replicas: -1 });
  assert.equal(res.status, 400);
});

test('POST /deployments/:name/scale scales a deployment', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');
  t.mock.method(workloadsService, 'scaleDeployment', async () => ({ spec: { replicas: 3 } }));

  const res = await request(app()).post('/api/workloads/deployments/web/scale?namespace=default').send({ replicas: 3 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { spec: { replicas: 3 } });
});

test('GET /deployments/:name/history returns revision history', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');
  t.mock.method(workloadsService, 'deploymentHistory', async () => ({ revisions: [] }));

  const res = await request(app()).get('/api/workloads/deployments/web/history?namespace=default');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { revisions: [] });
});

test('POST /deployments/:name/rollback rejects a non-positive revision', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');

  const res = await request(app())
    .post('/api/workloads/deployments/web/rollback?namespace=default')
    .send({ revision: 0 });
  assert.equal(res.status, 400);
});

test('POST /deployments/:name/rollback rolls back a deployment', async (t) => {
  t.mock.method(workloadsService, 'requireNamespace', () => 'default');
  t.mock.method(workloadsService, 'rollbackDeployment', async () => ({ rolledBackTo: 2 }));

  const res = await request(app())
    .post('/api/workloads/deployments/web/rollback?namespace=default')
    .send({ revision: 2 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rolledBackTo: 2 });
});

