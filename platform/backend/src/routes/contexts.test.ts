import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { contextsService } from '../services/contextsService.js';
import { kube } from '../kube/client.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

// contexts.ts writes/reads local kubeconfig files and tags context sources
// through these free-function stores; mock them at the top level (before the
// router is first imported) so the router picks up the mocked bindings.
mock.module('../runtime/desktopStore.js', {
  namedExports: {
    listDesktopLocalKubeconfigs: async () => [],
    upsertDesktopLocalKubeconfig: async () => undefined,
    findDesktopLocalKubeconfig: async () => undefined,
    deleteDesktopLocalKubeconfig: async () => undefined,
    replaceDesktopLocalKubeconfigContexts: async () => undefined,
    listDesktopContextSources: async () => [],
    getDesktopContextSource: async () => undefined,
    upsertDesktopContextSource: async () => undefined,
    deleteDesktopContextSourcesForNames: async () => undefined,
  },
});
mock.module('../kube/kubeconfigFile.js', {
  namedExports: {
    removeContextsFromKubeconfigFile: async () => undefined,
  },
});
mock.module('../kube/kubeConfigRepair.js', {
  namedExports: {
    repairKubeconfigContent: (content: string) => content,
  },
});

const { contextsRouter } = await import('./contexts.js');

function app() {
  return buildTestApp('/api/contexts', contextsRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/contexts returns the cached payload', async (t) => {
  t.mock.method(contextsService, 'getCachedPayload', async () => ({ contexts: [], localKubeconfigs: [] }));

  const res = await request(app()).get('/api/contexts');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { contexts: [], localKubeconfigs: [] });
});

test('POST /api/contexts/active requires a name', async () => {
  const res = await request(app()).post('/api/contexts/active').send({});
  assert.equal(res.status, 400);
});

test('POST /api/contexts/disconnect clears the active context', async () => {
  const res = await request(app()).post('/api/contexts/disconnect');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {});
});test('POST /api/contexts/reload invalidates the cache and returns a fresh payload', async (t) => {
  t.mock.method(contextsService, 'invalidateCache', () => undefined);
  t.mock.method(contextsService, 'getCachedPayload', async () => ({ contexts: [] }));

  const res = await request(app()).post('/api/contexts/reload');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { contexts: [] });
});

test('POST /api/contexts/local-kubeconfigs requires name and content', async () => {
  const res = await request(app()).post('/api/contexts/local-kubeconfigs').send({});
  assert.equal(res.status, 400);
});

test('POST /api/contexts/local-kubeconfigs stores a kubeconfig', async (t) => {
  t.mock.method(contextsService, 'invalidateCache', () => undefined);
  t.mock.method(contextsService, 'parseKubeconfigContexts', () => ['ctx-1']);
  t.mock.method(kube, 'getContexts', async () => []);

  const res = await request(app())
    .post('/api/contexts/local-kubeconfigs')
    .send({ name: 'my-config', content: 'apiVersion: v1\nkind: Config' });
  assert.equal(res.status, 201);
});

test('DELETE /api/contexts/local-kubeconfigs/:id removes a stored kubeconfig', async (t) => {
  t.mock.method(contextsService, 'invalidateCache', () => undefined);
  t.mock.method(kube, 'getContexts', async () => []);

  const res = await request(app()).delete('/api/contexts/local-kubeconfigs/abc123');
  assert.equal(res.status, 200);
});
