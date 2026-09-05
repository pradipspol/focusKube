import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minikubeService } from '../services/minikubeService.js';
import { buildTestApp, makeTestAuthUser, makeTestSession } from '../testUtils/testApp.js';
import { minikubeRouter } from './minikube.js';

function app(session = makeTestSession()) {
  return buildTestApp('/api/minikube', minikubeRouter, { authUser: makeTestAuthUser(), session });
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

test('POST /api/minikube/connect writes the exported kubeconfig to the session-scoped path, not the home directory', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minikube-connect-test-'));
  const minikubeKubeconfigPath = path.join(dir, 'config');
  const exportedKubeconfig = 'apiVersion: v1\nkind: Config\ncurrent-context: minikube\n';

  t.mock.method(minikubeService, 'exportKubeconfig', async () => ({
    clusterName: 'minikube',
    kubeconfig: exportedKubeconfig,
  }));

  const response = await request(app(makeTestSession({ minikubeKubeconfigPath })))
    .post('/api/minikube/connect');

  assert.equal(response.status, 200);
  assert.equal(response.body.contextName, 'minikube');
  const written = await fsp.readFile(minikubeKubeconfigPath, 'utf8');
  assert.equal(written, exportedKubeconfig);
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
