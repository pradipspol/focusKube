import test from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import { kube } from './client.js';
import { listResourcePage, RESOURCE_KINDS } from './resources.js';

test('listResourcePage forwards limit and continue for namespaced generic kinds', async (t) => {
  let listArgs: unknown[] = [];
  t.mock.method(kube, 'rawConfig', async () => ({} as any));
  t.mock.method(k8s.KubernetesObjectApi, 'makeApiClient', () => ({
    list: async (...args: unknown[]) => {
      listArgs = args;
      return {
        body: {
          items: [{ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'budget', namespace: 'apps' } }],
          metadata: { continue: 'next-page', resourceVersion: 'rv-123' },
        },
      };
    },
  }) as any);

  const page = await listResourcePage('poddisruptionbudgets', 'test-context', 'apps', {
    kubeconfigPath: '/tmp/test',
    fallbackContext: null,
    limit: 25,
    continue: 'previous-page',
  });

  assert.deepEqual(listArgs.slice(0, 3), ['policy/v1', 'PodDisruptionBudget', 'apps']);
  assert.equal(listArgs[6], undefined);
  assert.equal(listArgs[7], undefined);
  assert.equal(listArgs[8], 25);
  assert.equal(listArgs[9], 'previous-page');
  assert.deepEqual(page.items.map((item) => item.metadata.name), ['budget']);
  assert.equal(page.continue, 'next-page');
  assert.equal(page.resourceVersion, 'rv-123');
});

test('listResourcePage returns the generated Kubernetes client continuation field', async (t) => {
  t.mock.method(kube, 'rawConfig', async () => ({} as any));
  t.mock.method(k8s.KubernetesObjectApi, 'makeApiClient', () => ({
    list: async () => ({
      body: {
        items: [],
          metadata: { _continue: 'next-page', resourceVersion: 'rv-123', remainingItemCount: 82 },
      },
    }),
  }) as any);

  const page = await listResourcePage('pods', 'test-context', 'default', {
    kubeconfigPath: '/tmp/test', fallbackContext: null, limit: 50,
  });

  assert.equal(page.continue, 'next-page');
  assert.equal(page.resourceVersion, 'rv-123');
  assert.equal(page.remainingItemCount, 82);
});

test('listResourcePage supports cluster-scoped kinds and sanitizes Secret pages', async (t) => {
  const kinds: Array<[string, string | undefined, number]> = [];
  t.mock.method(kube, 'rawConfig', async () => ({} as any));
  t.mock.method(k8s.KubernetesObjectApi, 'makeApiClient', () => ({
    list: async (apiVersion: string, kind: string, namespace: string | undefined) => {
      kinds.push([kind, namespace, kinds.length]);
      return {
        body: {
          items: [{ apiVersion, kind, metadata: { name: 'sample' }, data: { password: 'secret-value' } }],
          metadata: { resourceVersion: 'rv-cluster' },
        },
      };
    },
  }) as any);

  const nodes = await listResourcePage('nodes', 'test-context', undefined, {
    kubeconfigPath: '/tmp/test', fallbackContext: null, limit: 10,
  });
  const secrets = await listResourcePage('secrets', 'test-context', 'apps', {
    kubeconfigPath: '/tmp/test', fallbackContext: null, limit: 10,
  });

  assert.deepEqual(kinds.map(([kind, namespace]) => [kind, namespace]), [['Node', undefined], ['Secret', 'apps']]);
  assert.deepEqual(nodes.items.map((item) => item.metadata.name), ['sample']);
  assert.deepEqual(secrets.items[0].dataKeys, ['password']);
  assert.equal(JSON.stringify(secrets).includes('secret-value'), false);
});

test('listResourcePage uses the generic paged list API for every registered kind', async (t) => {
  const calls: Array<{ apiVersion: string; kind: string; namespace?: string; limit?: number; continuation?: string }> = [];
  t.mock.method(kube, 'rawConfig', async () => ({} as any));
  t.mock.method(k8s.KubernetesObjectApi, 'makeApiClient', () => ({
    list: async (apiVersion: string, kind: string, namespace: string | undefined, ...args: unknown[]) => {
      calls.push({ apiVersion, kind, namespace, limit: args[5] as number, continuation: args[6] as string });
      return { body: { items: [], metadata: { resourceVersion: 'rv' } } };
    },
  }) as any);

  for (const [plural, resource] of Object.entries(RESOURCE_KINDS)) {
    await listResourcePage(plural, 'test-context', resource.namespaced ? 'team-a' : undefined, {
      kubeconfigPath: '/tmp/test', fallbackContext: null, limit: 17, continue: `token-${plural}`,
    });
  }

  assert.equal(calls.length, Object.keys(RESOURCE_KINDS).length);
  for (const [plural, resource] of Object.entries(RESOURCE_KINDS)) {
    const call = calls.find((item) => item.kind === resource.kind);
    assert.ok(call, `missing paged API call for ${plural}`);
    assert.equal(call.apiVersion, resource.apiVersion);
    assert.equal(call.namespace, resource.namespaced ? 'team-a' : undefined);
    assert.equal(call.limit, 17);
    assert.equal(call.continuation, `token-${plural}`);
  }
});
