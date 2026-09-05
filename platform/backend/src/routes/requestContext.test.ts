import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import type { UserSessionState } from '../auth/session.js';
import { HttpError } from '../util/httpError.js';
import {
  kubeOptionsForScope,
  requestedContextFromQuery,
  requestedSourceFromQuery,
  resolveScopedRequestContext,
} from './requestContext.js';

function makeSession(overrides: Partial<UserSessionState> = {}): UserSessionState {
  return {
    userId: 'u1',
    activeContext: 'ctx-active',
    activeContextSource: 'azure',
    localKubeconfigPath: '/tmp/local-kubeconfig',
    minikubeKubeconfigPath: '/tmp/minikube-kubeconfig',
    localAzureConfigDir: '/tmp/local-azure',
    cloudKubeconfigPath: '/tmp/cloud-kubeconfig',
    cloudAzureConfigDir: '/tmp/cloud-azure',
    awsKubeconfigPath: '/tmp/aws-kubeconfig',
    azureLogin: {} as any,
    azureLoginCloud: {} as any,
    azureLoginLocal: {} as any,
    azureLoginCloudPending: null,
    contextSourceHints: {},
    awsConfigFile: '/tmp/aws-config',
    awsCredentialsFile: '/tmp/aws-credentials',
    awsProfile: 'default',
    awsLogin: {} as any,
    ...overrides,
  };
}

function makeRequest(query: Record<string, string | undefined>, session: UserSessionState): Request {
  return {
    query,
    userSession: session,
  } as unknown as Request;
}

test('requestContext helpers parse query values', () => {
  const req = makeRequest({ context: 'ctx-a', source: 'aws' }, makeSession());
  assert.equal(requestedContextFromQuery(req), 'ctx-a');
  assert.equal(requestedSourceFromQuery(req), 'aws');
});

test('resolveScopedRequestContext resolves local source paths for local context hint', async () => {
  const session = makeSession({
    contextSourceHints: { 'ctx-local': 'local' },
    activeContext: 'ctx-active',
    activeContextSource: 'azure',
  });
  const req = makeRequest({ context: 'ctx-local' }, session);

  const scoped = await resolveScopedRequestContext(req);
  assert.equal(scoped.selectedScope, 'local');
  assert.equal(scoped.selectedKubeconfigPath, '/tmp/local-kubeconfig');
  assert.equal(scoped.selectedAzureConfigDir, '/tmp/local-azure');

  const kubeOpts = kubeOptionsForScope(req, scoped);
  assert.deepEqual(kubeOpts, {
    kubeconfigPath: '/tmp/local-kubeconfig',
    fallbackContext: 'ctx-active',
    azureConfigDir: '/tmp/local-azure',
  });
});

test('resolveScopedRequestContext enforces explicit source membership', async () => {
  const session = makeSession({
    contextSourceHints: { 'ctx-aws': 'aws' },
  });
  const req = makeRequest({ context: 'ctx-aws', source: 'aws' }, session);

  await assert.rejects(() => resolveScopedRequestContext(req), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match((err as Error).message, /not available in aws source/i);
    return true;
  });
});
