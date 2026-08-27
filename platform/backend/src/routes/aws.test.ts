import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { buildTestApp, makeTestAuthUser, makeTestSession } from '../testUtils/testApp.js';

const realAws = await import('../aws/aws.js');
let identityResult: unknown = { account: '123456789012', arn: 'arn:aws:iam::123456789012:user/me' };
let eksResult: { clusters: unknown[] } = { clusters: [] };

mock.module('../aws/aws.js', {
  namedExports: {
    ...realAws,
    awsStsGetCallerIdentity: async () => identityResult,
    awsListEks: async () => eksResult,
    awsSsoLogout: async () => undefined,
    writeAwsSsoProfileConfig: async () => undefined,
    writeAwsStaticProfileConfig: async () => undefined,
    writeAwsRoleProfileConfig: async () => undefined,
    awsUpdateEksKubeconfig: async () => undefined,
  },
});
mock.module('../kube/client.js', {
  namedExports: {
    ...(await import('../kube/client.js')),
    kube: { getContexts: async () => [] },
  },
});
mock.module('../kube/kubeconfigFile.js', {
  namedExports: { removeContextsFromKubeconfigFile: async () => undefined },
});
mock.module('../runtime/desktopStore.js', {
  namedExports: {
    ...(await import('../runtime/desktopStore.js')),
    upsertDesktopContextSource: async () => undefined,
    listDesktopContextSources: async () => [],
    deleteDesktopContextSourcesForNames: async () => undefined,
  },
});

const { awsRouter } = await import('./aws.js');

function app(session = makeTestSession({ awsLogin: { getStatus: () => ({ state: 'signed-out' }), start: async () => ({ ok: true }) } as any })) {
  return buildTestApp('/api/aws', awsRouter, { authUser: makeTestAuthUser(), session });
}

test('GET /api/aws/account returns the signed-in identity', async () => {
  identityResult = { account: '123456789012' };

  const res = await request(app()).get('/api/aws/account');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { account: { account: '123456789012' } });
});

test('POST /api/aws/login starts the login flow', async () => {
  const res = await request(app()).post('/api/aws/login');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('GET /api/aws/login/status returns the login manager status', async () => {
  const res = await request(app()).get('/api/aws/login/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'signed-out' });
});

test('POST /api/aws/configure-auth requires a valid body', async () => {
  const res = await request(app()).post('/api/aws/configure-auth').send({ mode: 'static' });
  assert.equal(res.status, 400);
});

test('POST /api/aws/configure-auth configures static credentials', async () => {
  const res = await request(app())
    .post('/api/aws/configure-auth')
    .send({
      mode: 'static',
      profileName: 'default',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, profileName: 'default', mode: 'static' });
});

test('GET /api/aws/eks lists clusters', async () => {
  eksResult = { clusters: [{ name: 'demo-cluster' }] };

  const res = await request(app()).get('/api/aws/eks');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { clusters: [{ name: 'demo-cluster' }] });
});

test('POST /api/aws/eks/credentials requires region and name', async () => {
  const res = await request(app()).post('/api/aws/eks/credentials').send({});
  assert.equal(res.status, 400);
});

test('POST /api/aws/logout signs out', async () => {
  const res = await request(app()).post('/api/aws/logout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
