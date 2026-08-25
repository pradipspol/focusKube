import test from 'node:test';
import assert from 'node:assert/strict';
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
