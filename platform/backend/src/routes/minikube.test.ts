import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { minikubeService } from '../services/minikubeService.js';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';
import { minikubeRouter } from './minikube.js';

function app() {
  return buildTestApp('/api/minikube', minikubeRouter, { authUser: makeTestAuthUser() });
}

test('GET /api/minikube/health returns installation status', async (t) => {
  t.mock.method(minikubeService, 'isMinikubeInstalled', async () => true);

  const response = await request(app()).get('/api/minikube/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.installed, true);
});

test('GET /api/minikube/status returns cluster status', async (t) => {
  const status = {
    name: 'minikube',
    status: 'running' as const,
    driver: 'docker',
    kubernetesVersion: 'v1.24.0',
  };
  t.mock.method(minikubeService, 'getStatus', async () => status);

  const response = await request(app()).get('/api/minikube/status').query({ clusterName: 'minikube' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, status);
});

test('POST /api/minikube/start starts a cluster', async (t) => {
  t.mock.method(minikubeService, 'startCluster', async () => ({
    name: 'minikube',
    status: 'running' as const,
    driver: 'docker',
  }));

  const response = await request(app())
    .post('/api/minikube/start')
    .send({ driver: 'docker', cpus: 4, memory: '4096m' });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'running');
});

test('POST /api/minikube/deploy deploys a manifest', async (t) => {
  const manifest = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: test';
  t.mock.method(minikubeService, 'deployManifest', async () => ({ success: true, output: 'pod created' }));

  const response = await request(app())
    .post('/api/minikube/deploy')
    .send({ manifest, clusterName: 'minikube' });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
});

test('POST /api/minikube/deploy rejects an empty manifest', async () => {
  const response = await request(app())
    .post('/api/minikube/deploy')
    .send({ manifest: '', clusterName: 'minikube' });

  assert.equal(response.status, 400);
});

test('GET /api/minikube/pods returns pods', async (t) => {
  const pods = [{
    name: 'test-pod',
    namespace: 'default',
    status: 'Running',
    ready: '1/1',
    restarts: 0,
    age: '1h',
  }];
  t.mock.method(minikubeService, 'getPods', async () => pods);

  const response = await request(app())
    .get('/api/minikube/pods')
    .query({ clusterName: 'minikube', namespace: 'default' });

  assert.equal(response.status, 200);
  assert.equal(response.body.pods[0].name, 'test-pod');
});

test('GET /api/minikube/pods/:podName/logs returns logs', async (t) => {
  t.mock.method(minikubeService, 'getPodLogs', async () => 'Starting pod...\nReady');

  const response = await request(app())
    .get('/api/minikube/pods/test-pod/logs')
    .query({ clusterName: 'minikube', namespace: 'default' });

  assert.equal(response.status, 200);
  assert.equal(response.body.logs, 'Starting pod...\nReady');
});

test('GET /api/minikube/setup-scripts returns downloadable scripts', async (t) => {
  t.mock.method(minikubeService, 'getSetupScripts', async () => ([
    {
      id: 'windows-powershell-docker',
      title: 'Windows PowerShell - Docker Desktop',
      filename: 'focuskube-minikube-windows-docker.ps1',
      platform: 'windows' as const,
      driver: 'docker' as const,
      shell: 'powershell' as const,
      content: 'Write-Host "hello"',
    },
  ]));

  const response = await request(app()).get('/api/minikube/setup-scripts');

  assert.equal(response.status, 200);
  assert.equal(response.body.scripts[0].filename, 'focuskube-minikube-windows-docker.ps1');
});

test('POST /api/minikube/pods/:podName/test tests connectivity', async (t) => {
  t.mock.method(minikubeService, 'testPod', async () => ({
    name: 'test-pod',
    status: 'Running',
    readiness: true,
    logs: 'Ready',
  }));

  const response = await request(app())
    .post('/api/minikube/pods/test-pod/test')
    .query({ clusterName: 'minikube', namespace: 'default' });

  assert.equal(response.status, 200);
  assert.equal(response.body.readiness, true);
});
