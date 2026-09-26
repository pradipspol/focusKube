import test from 'node:test';
import assert from 'node:assert/strict';
import { kube } from '../kube/client.js';
import { HttpError } from '../util/httpError.js';
import { ResourcesService } from './resourcesService.js';

const service = new ResourcesService();

test('resourcesService.parseApplyManifest throws on non-object YAML', () => {
  assert.throws(() => service.parseApplyManifest('- one\n- two'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match((err as Error).message, /YAML must be a single Kubernetes object/);
    return true;
  });
});

test('resourcesService.parseApplyManifest throws when apiVersion/kind/name missing', () => {
  assert.throws(() => service.parseApplyManifest('kind: ConfigMap\nmetadata:\n  namespace: default\n'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match((err as Error).message, /must include apiVersion, kind and metadata.name/);
    return true;
  });
});

test('resourcesService.parseApplyManifest defaults namespace when omitted', () => {
  const manifest = service.parseApplyManifest(
    [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: demo',
    ].join('\n'),
    'demo-ns',
  );

  assert.equal(manifest.metadata.namespace, 'demo-ns');
});

test('resourcesService.parseEditableManifest rejects mismatched kind', () => {
  const raw = [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: svc-a',
  ].join('\n');

  assert.throws(() => service.parseEditableManifest(raw, 'configmaps', 'svc-a'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match((err as Error).message, /does not match/);
    return true;
  });
});

test('resourcesService.parseEditableManifest rejects metadata.name changes', () => {
  const raw = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: cm-b',
  ].join('\n');

  assert.throws(() => service.parseEditableManifest(raw, 'configmaps', 'cm-a'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match((err as Error).message, /Changing metadata.name is not allowed/);
    return true;
  });
});

test('resourcesService.listResources rejects invalid pagination limits', async () => {
  for (const rawLimit of ['1.5', '']) {
    await assert.rejects(
      service.listResources('pods', 'ctx', 'default', {
        kubeconfigPath: '/tmp/test', fallbackContext: null,
      }, {
        rawLimit,
        selectedScope: 'local',
        selectedKubeconfigPath: '/tmp/test',
      }),
      (error: unknown) => error instanceof HttpError && error.status === 400 && /positive integer/.test(error.message),
    );
  }
});

test('resourcesService.getPodMetricsBatch lists once per namespace and matches requested pods', async (t) => {
  const namespaces: string[] = [];
  const metrics = (namespace: string, name: string) => ({
    metadata: { namespace, name },
    timestamp: '2026-01-01T00:00:00Z',
    containers: [{ name: 'app', usage: { cpu: '100m', memory: '2Mi' } }],
  });
  const api = {
    listNamespacedCustomObject: async (_group: string, _version: string, namespace: string) => {
      namespaces.push(namespace);
      return { body: { items: namespace === 'alpha' ? [metrics('alpha', 'a')] : [metrics('beta', 'b')] } };
    },
  };
  t.mock.method(kube, 'rawConfig', async () => ({ makeApiClient: () => api }) as any);

  const result = await service.getPodMetricsBatch(
    [{ name: 'a', namespace: 'alpha' }, { name: 'missing', namespace: 'alpha' }, { name: 'b', namespace: 'beta' }, { name: 'a', namespace: 'alpha' }],
    undefined,
    'test-context',
    { kubeconfigPath: '/tmp/test', fallbackContext: null },
  );

  assert.deepEqual(namespaces.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.items.map(({ name, namespace }) => [namespace, name]), [['alpha', 'a'], ['alpha', 'missing'], ['beta', 'b']]);
  assert.equal(result.items[0].snapshot.containers[0].cpuMillicores, 100);
  assert.equal(result.items[0].snapshot.containers[0].memoryBytes, 2 * 1024 * 1024);
  assert.match(result.items[1].error ?? '', /metrics.*not available/i);
  assert.equal(result.items[2].snapshot.containers[0].cpuMillicores, 100);
});

test('resourcesService.getPodMetricsBatch isolates namespace collection errors', async (t) => {
  const api = {
    listNamespacedCustomObject: async (_group: string, _version: string, namespace: string) => {
      if (namespace === 'restricted') throw new Error('metrics list forbidden');
      return { body: { items: [{ metadata: { name: 'available' }, containers: [] }] } };
    },
  };
  t.mock.method(kube, 'rawConfig', async () => ({ makeApiClient: () => api }) as any);

  const result = await service.getPodMetricsBatch(
    [{ name: 'blocked', namespace: 'restricted' }, { name: 'available', namespace: 'permitted' }],
    undefined,
    'test-context',
    { kubeconfigPath: '/tmp/test', fallbackContext: null },
  );

  assert.match(result.items[0].error ?? '', /metrics list forbidden/);
  assert.deepEqual(result.items[1].snapshot?.containers, []);
});
