import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextsService, type ContextEntry } from './contextsService.js';

function sampleEntry(name: string, scope: 'local' | 'azure' | 'aws'): ContextEntry {
  return {
    scope,
    ctx: {
      name,
      cluster: `${name}-cluster`,
      user: `${name}-user`,
      active: false,
    },
  };
}

test('contextsService source mapping falls back by scope when source doc missing', () => {
  const service = new ContextsService();

  const local = service.sourceForEntry('local', 'ctx-local');
  assert.deepEqual(local, { provider: 'local' });

  const aws = service.sourceForEntry('aws', 'ctx-aws');
  assert.deepEqual(aws, { provider: 'eks', clusterName: 'ctx-aws' });

  const azure = service.sourceForEntry('azure', 'ctx-az');
  assert.deepEqual(azure, { provider: 'aks', clusterName: 'ctx-az' });
});

test('contextsService source mapping prefers explicit source docs', () => {
  const service = new ContextsService();

  const eks = service.sourceForEntry('aws', 'ctx-1', {
    contextName: 'ctx-1',
    scope: 'aws',
    source: 'eks',
    accountId: '123',
    region: 'us-east-1',
    clusterName: 'real-eks',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.deepEqual(eks, {
    provider: 'eks',
    accountId: '123',
    region: 'us-east-1',
    clusterName: 'real-eks',
  });

  const aks = service.sourceForEntry('azure', 'ctx-2', {
    contextName: 'ctx-2',
    scope: 'azure',
    source: 'aks',
    subscriptionId: 'sub',
    subscriptionName: 'sub-name',
    resourceGroup: 'rg',
    clusterName: 'real-aks',
    accountId: 'account-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // accountId must round-trip to the client just like it already does for eks above -
  // it's what SidebarProviderSources.tsx's matchContextsForCluster uses to stop one
  // account's imported cluster from rendering under a different account's tree node.
  assert.deepEqual(aks, {
    provider: 'aks',
    subscriptionId: 'sub',
    subscriptionName: 'sub-name',
    resourceGroup: 'rg',
    clusterName: 'real-aks',
    accountId: 'account-1',
  });
});

test('contextsService buildPayload keeps source keyed by scope+name', () => {
  const service = new ContextsService();
  const entries = [
    sampleEntry('same-name', 'local'),
    sampleEntry('same-name', 'aws'),
  ];

  const payload = service.buildPayload({
    activeContext: 'same-name',
    entries,
    sourceDocs: [
      {
        contextName: 'same-name',
        scope: 'aws',
        source: 'eks',
        accountId: '111',
        region: 'us-west-2',
        clusterName: 'eks-cluster',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    localKubeconfigs: [],
  });

  const localSource = payload.contexts.find((c) => c.name === 'same-name' && c.source?.provider === 'local');
  const awsSource = payload.contexts.find((c) => c.name === 'same-name' && c.source?.provider === 'eks');

  assert.ok(localSource);
  assert.ok(awsSource);
  assert.equal((awsSource?.source as any).clusterName, 'eks-cluster');
});

test('contextsService cache returns cached value until invalidated', async () => {
  const service = new ContextsService();
  const userId = 'user-cache';

  let loaderCalls = 0;
  const first = await service.getCachedPayload(
    userId,
    async () => {
      loaderCalls += 1;
      return {
        active: 'ctx-a',
        contexts: [],
        localKubeconfigs: [],
      };
    },
    async () => ({ active: 'fallback', contexts: [], localKubeconfigs: [] }),
    () => {},
  );

  assert.equal(first.active, 'ctx-a');
  assert.equal(loaderCalls, 1);

  const second = await service.getCachedPayload(
    userId,
    async () => {
      loaderCalls += 1;
      return {
        active: 'ctx-b',
        contexts: [],
        localKubeconfigs: [],
      };
    },
    async () => ({ active: 'fallback', contexts: [], localKubeconfigs: [] }),
    () => {},
  );

  assert.equal(second.active, 'ctx-a');
  assert.equal(loaderCalls, 1);

  service.invalidateCache(userId);

  const third = await service.getCachedPayload(
    userId,
    async () => {
      loaderCalls += 1;
      return {
        active: 'ctx-c',
        contexts: [],
        localKubeconfigs: [],
      };
    },
    async () => ({ active: 'fallback', contexts: [], localKubeconfigs: [] }),
    () => {},
  );

  assert.equal(third.active, 'ctx-c');
  assert.equal(loaderCalls, 2);
});
