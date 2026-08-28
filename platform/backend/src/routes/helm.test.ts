import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import fs from 'node:fs';
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
mock.module('../kube/client.js', {
  namedExports: {
    ...(await import('../kube/client.js')),
    kube: {
      resolveContextName: async () => 'ctx-active',
      rawConfig: async () => ({
        exportConfig: () => 'apiVersion: v1\nkind: Config\ncurrent-context: ctx-active\n',
      }),
    },
  },
});

let runResult: { stdout: string; stderr: string; code: number } = { stdout: '[]', stderr: '', code: 0 };
let lastRunOptions: any;
const realRun = await import('../util/run.js');
mock.module('../util/run.js', {
  namedExports: {
    ...realRun,
    run: async (_cmd: string, _args: string[], options: any = {}) => {
      lastRunOptions = options;
      return runResult;
    },
    runOrThrow: async (_cmd: string, _args: string[], options: any = {}) => {
      lastRunOptions = options;
      if (runResult.code !== 0) throw new Error(runResult.stderr || 'command failed');
      return runResult;
    },
  },
});

const { helmRouter } = await import('./helm.js');

function app() {
  return buildTestApp('/api/helm', helmRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/helm/releases lists releases', async () => {
  runResult = { stdout: JSON.stringify([{ name: 'demo' }]), stderr: '', code: 0 };
  lastRunOptions = undefined;

  const res = await request(app()).get('/api/helm/releases');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { releases: [{ name: 'demo' }] });
  assert.notEqual(lastRunOptions.env.KUBECONFIG, scoped.selectedKubeconfigPath);
  assert.equal(fs.existsSync(lastRunOptions.env.KUBECONFIG), false);
});

test('POST /api/helm/repos requires name and a valid url', async () => {
  const res = await request(app()).post('/api/helm/repos').send({ name: 'bitnami' });
  assert.equal(res.status, 400);
});

test('POST /api/helm/repos adds a repo', async () => {
  runResult = { stdout: '', stderr: '', code: 0 };

  const res = await request(app())
    .post('/api/helm/repos')
    .send({ name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' });
});

test('GET /api/helm/repos returns an empty list on failure', async () => {
  runResult = { stdout: '', stderr: 'boom', code: 1 };

  const res = await request(app()).get('/api/helm/repos');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { repos: [] });
});

test('GET /api/helm/charts treats "no repositories" as an empty list', async () => {
  runResult = { stdout: '', stderr: 'Error: no repositories to show', code: 1 };

  const res = await request(app()).get('/api/helm/charts');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { charts: [] });
});

test('GET /api/helm/releases/:name/history returns history', async () => {
  runResult = { stdout: JSON.stringify([{ revision: 1 }]), stderr: '', code: 0 };

  const res = await request(app()).get('/api/helm/releases/demo/history?namespace=default');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { history: [{ revision: 1 }] });
});

test('POST /api/helm/releases/:name/rollback requires a positive revision', async () => {
  const res = await request(app()).post('/api/helm/releases/demo/rollback').send({ revision: -1 });
  assert.equal(res.status, 400);
});

test('POST /api/helm/releases/:name/rollback rolls back', async () => {
  runResult = { stdout: 'rolled back', stderr: '', code: 0 };

  const res = await request(app())
    .post('/api/helm/releases/demo/rollback?namespace=default')
    .send({ revision: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, output: 'rolled back' });
});

test('POST /api/helm/releases requires a valid install request', async () => {
  const res = await request(app()).post('/api/helm/releases').send({ chart: 'bitnami/nginx' });
  assert.equal(res.status, 400);
});

test('POST /api/helm/releases installs a chart', async () => {
  runResult = { stdout: 'installed', stderr: '', code: 0 };

  const res = await request(app())
    .post('/api/helm/releases')
    .send({ chart: 'bitnami/nginx', releaseName: 'web', namespace: 'default' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, output: 'installed' });
});

test('POST /api/helm/releases surfaces a helm failure as 400', async () => {
  runResult = { stdout: '', stderr: 'install failed', code: 1 };

  const res = await request(app())
    .post('/api/helm/releases')
    .send({ chart: 'bitnami/nginx', releaseName: 'web', namespace: 'default' });
  assert.equal(res.status, 400);
});
