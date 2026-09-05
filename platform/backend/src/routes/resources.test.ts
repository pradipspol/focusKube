import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { resourcesService } from '../services/resourcesService.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';
import { badRequest } from '../util/httpError.js';

const scoped = {
  requestedContext: 'ctx-active',
  requestedSource: undefined,
  selectedScope: 'azure' as const,
  selectedKubeconfigPath: '/tmp/cloud-kubeconfig',
  selectedAzureConfigDir: '/tmp/cloud-azure',
};

// Module mocking must happen before the router module (and thus this module's
// own live bindings to requestContext.js) is first imported, so this is done
// once at the top level rather than per-test.
mock.module('./requestContext.js', {
  namedExports: {
    resolveScopedRequestContext: async () => scoped,
    ensureScopedContextAuth: async () => undefined,
    kubeOptionsForScope: () => ({ kubeconfigPath: scoped.selectedKubeconfigPath, fallbackContext: 'ctx-active' }),
    requestedContextFromQuery: () => undefined,
    requestedSourceFromQuery: () => undefined,
  },
});

const { resourcesRouter } = await import('./resources.js');

function app() {
  return buildTestApp('/api/resources', resourcesRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/resources/_kinds lists resource kinds', async (t) => {
  t.mock.method(resourcesService, 'listKinds', () => [{ kind: 'Pod', plural: 'pods' }]);

  const res = await request(app()).get('/api/resources/_kinds');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ kind: 'Pod', plural: 'pods' }]);
});

test('POST /api/resources/_validate requires yaml', async (t) => {
  const res = await request(app()).post('/api/resources/_validate').send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /yaml is required/);
});

test('POST /api/resources/_validate parses a valid manifest', async (t) => {
  t.mock.method(resourcesService, 'parseApplyManifest', () => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'demo', namespace: 'default' },
  }));

  const res = await request(app()).post('/api/resources/_validate').send({ yaml: 'kind: ConfigMap' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { apiVersion: 'v1', kind: 'ConfigMap', name: 'demo', namespace: 'default' });
});

test('POST /api/resources/_apply creates a resource (201)', async (t) => {
  t.mock.method(resourcesService, 'parseApplyManifest', () => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'demo', namespace: 'default' },
  }));
  t.mock.method(resourcesService, 'applyResource', async () => ({ object: { kind: 'ConfigMap' }, created: true }));

  const res = await request(app()).post('/api/resources/_apply').send({ yaml: 'kind: ConfigMap' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { object: { kind: 'ConfigMap' }, created: true });
});

test('GET /api/resources/pods/:name/metrics requires namespace', async (t) => {
  const res = await request(app()).get('/api/resources/pods/my-pod/metrics');
  assert.equal(res.status, 400);
});

test('GET /api/resources/pods/:name/metrics returns snapshot', async (t) => {
  t.mock.method(resourcesService, 'getPodMetrics', async () => ({ containers: [] }));

  const res = await request(app()).get('/api/resources/pods/my-pod/metrics?namespace=default');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { containers: [] });
});

test('POST /api/resources/pods/metrics/batch returns batch results', async (t) => {
  t.mock.method(resourcesService, 'parseBatchPods', () => [{ name: 'p1' }]);
  t.mock.method(resourcesService, 'getPodMetricsBatch', async () => ({ items: [{ name: 'p1' }] }));

  const res = await request(app()).post('/api/resources/pods/metrics/batch').send({ pods: ['p1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [{ name: 'p1' }] });
});

test('GET /api/resources/:plural lists resources', async (t) => {
  t.mock.method(resourcesService, 'listResources', async () => ({ items: [{ metadata: { name: 'a' } }] }));

  const res = await request(app()).get('/api/resources/pods');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [{ metadata: { name: 'a' } }] });
});

test('GET /api/resources/:plural/:name returns a single resource', async (t) => {
  t.mock.method(resourcesService, 'getResource', async () => ({ metadata: { name: 'a' } }));

  const res = await request(app()).get('/api/resources/pods/a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { metadata: { name: 'a' } });
});

test('GET /api/resources/:plural/:name/yaml returns yaml text', async (t) => {
  t.mock.method(resourcesService, 'getResourceYaml', async () => ({ yaml: 'kind: Pod' }));

  const res = await request(app()).get('/api/resources/pods/a/yaml');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { yaml: 'kind: Pod' });
});

test('PUT /api/resources/:plural/:name/yaml requires yaml body', async (t) => {
  const res = await request(app()).put('/api/resources/pods/a/yaml').send({});
  assert.equal(res.status, 400);
});

test('PUT /api/resources/:plural/:name/yaml replaces from yaml', async (t) => {
  const calls: unknown[][] = [];
  t.mock.method(resourcesService, 'replaceFromYaml', async (...args: unknown[]) => {
    calls.push(args);
    return { metadata: { name: 'a' } };
  });

  const res = await request(app()).put('/api/resources/pods/a/yaml').send({ yaml: 'kind: Pod' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { metadata: { name: 'a' } });
  // A real save must never pass dryRun - that's the whole difference from the _validate route below.
  assert.equal(calls[0]?.[5], undefined);
});

test('POST /api/resources/:plural/:name/yaml/_validate requires yaml body', async (t) => {
  const res = await request(app()).post('/api/resources/pods/a/yaml/_validate').send({});
  assert.equal(res.status, 400);
});

test('POST /api/resources/:plural/:name/yaml/_validate dry-runs the update against the cluster without saving', async (t) => {
  const calls: unknown[][] = [];
  t.mock.method(resourcesService, 'replaceFromYaml', async (...args: unknown[]) => {
    calls.push(args);
    return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a', namespace: 'default' } };
  });

  const res = await request(app()).post('/api/resources/pods/a/yaml/_validate').send({ yaml: 'kind: Pod' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { apiVersion: 'v1', kind: 'Pod', name: 'a', namespace: 'default' });
  // dryRun must reach the service call - this is what stops the "validate" click from persisting anything.
  assert.equal(calls[0]?.[5], true);
});

test('POST /api/resources/:plural/:name/yaml/_validate surfaces the same rejection a real save would hit', async (t) => {
  t.mock.method(resourcesService, 'replaceFromYaml', async () => {
    throw badRequest('Service "svc" is invalid: spec.clusterIPs[0]: Invalid value: may not change once set');
  });

  const res = await request(app()).post('/api/resources/services/svc/yaml/_validate').send({ yaml: 'kind: Service' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /may not change once set/);
});

test('DELETE /api/resources/:plural/:name deletes a resource', async (t) => {
  t.mock.method(resourcesService, 'deleteResource', async () => ({ ok: true }));

  const res = await request(app()).delete('/api/resources/pods/a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

