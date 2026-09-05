import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { mergeAksCredentialsIntoKubeconfig, removeContextsFromKubeconfigFile } from './kubeconfigFile.js';

async function tmpPath(name: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kubeconfig-test-'));
  return path.join(dir, name);
}

/**
 * Mirrors real `az aks get-credentials` output, where the cluster, user and context entries
 * have DIFFERENT names (`users[].name` is `clusterUser_<rg>_<cluster>`) - a fixture that used
 * one name for all three would never exercise the rename/rewire path.
 */
function singleEntryKubeconfig(
  name: string,
  contextExtra: Record<string, unknown> = {},
  creds: { server?: string; token?: string } = {},
): string {
  return yaml.dump({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster: { server: creds.server ?? 'https://example.com' } }],
    users: [{ name: `clusterUser_rg_${name}`, user: { token: creds.token ?? 'abc' } }],
    contexts: [{ name, context: { cluster: name, user: `clusterUser_rg_${name}`, ...contextExtra } }],
    'current-context': name,
  });
}

test('mergeAksCredentialsIntoKubeconfig merges a scratch import under the resolved name into a fresh target', async () => {
  const target = await tmpPath('target.yaml');
  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('my-cluster'));

  const { contextName } = await mergeAksCredentialsIntoKubeconfig(source, target, (defaultName) => defaultName);
  assert.equal(contextName, 'my-cluster');

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.equal(doc.contexts.length, 1);
  assert.equal(doc.contexts[0].name, 'my-cluster');
  assert.equal(doc.clusters[0].name, 'my-cluster');
  assert.equal(doc.users[0].name, 'my-cluster');
});

test('mergeAksCredentialsIntoKubeconfig renames on collision instead of overwriting the existing entry', async () => {
  const target = await tmpPath('target.yaml');
  await fsp.writeFile(target, singleEntryKubeconfig('shared-name'));

  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('shared-name'));

  const { contextName } = await mergeAksCredentialsIntoKubeconfig(source, target, (defaultName) => `${defaultName}--other`);
  assert.equal(contextName, 'shared-name--other');

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.equal(doc.contexts.length, 2);
  assert.deepEqual(
    doc.contexts.map((c: any) => c.name).sort(),
    ['shared-name', 'shared-name--other'],
  );
});

test('mergeAksCredentialsIntoKubeconfig upserts by resolved name: re-importing the same name replaces it, not duplicates', async () => {
  const target = await tmpPath('target.yaml');
  const source1 = await tmpPath('source1.yaml');
  await fsp.writeFile(
    source1,
    singleEntryKubeconfig('my-cluster', { namespace: 'first' }, { server: 'https://one', token: 'tok-1' }),
  );
  await mergeAksCredentialsIntoKubeconfig(source1, target, (defaultName) => defaultName);

  const source2 = await tmpPath('source2.yaml');
  await fsp.writeFile(
    source2,
    singleEntryKubeconfig('my-cluster', { namespace: 'second' }, { server: 'https://two', token: 'tok-2' }),
  );
  await mergeAksCredentialsIntoKubeconfig(source2, target, (defaultName) => defaultName);

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.equal(doc.contexts.length, 1);
  assert.equal(doc.contexts[0].context.namespace, 'second');
  // The credentials must be replaced too, not just the context entry - and no stale
  // cluster/user entry may be left behind from the first import.
  assert.equal(doc.clusters.length, 1);
  assert.equal(doc.users.length, 1);
  assert.equal(doc.clusters[0].cluster.server, 'https://two');
  assert.equal(doc.users[0].user.token, 'tok-2');
  const ctx = doc.contexts[0].context;
  assert.equal(doc.clusters.find((c: any) => c.name === ctx.cluster).cluster.server, 'https://two');
  assert.equal(doc.users.find((u: any) => u.name === ctx.user).user.token, 'tok-2');
});

test('mergeAksCredentialsIntoKubeconfig never re-points another context whose cluster/user shares the resolved name', async () => {
  // `clusters`/`users`/`contexts` are separate namespaces, so a name can be free as a context
  // while still being in use as a cluster by an unrelated context (reachable via
  // removeContextsFromKubeconfigFile, `kubectl config rename-context`, or a hand-merged file).
  const target = await tmpPath('target.yaml');
  await fsp.writeFile(
    target,
    yaml.dump({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'web', cluster: { server: 'https://account-a' } }],
      users: [{ name: 'web', user: { token: 'account-a-token' } }],
      contexts: [{ name: 'alpha', context: { cluster: 'web', user: 'web' } }],
      'current-context': 'alpha',
    }),
  );

  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('web', {}, { server: 'https://account-b', token: 'account-b-token' }));

  // Caller sees no CONTEXT collision (no context is named 'web'), so it does not disambiguate.
  const { contextName } = await mergeAksCredentialsIntoKubeconfig(source, target, (defaultName) => defaultName);
  assert.equal(contextName, 'web');

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  const alpha = doc.contexts.find((c: any) => c.name === 'alpha');
  assert.ok(alpha, 'the pre-existing context must survive');
  assert.equal(
    doc.clusters.find((c: any) => c.name === alpha.context.cluster).cluster.server,
    'https://account-a',
    'alpha must still point at its own server',
  );
  assert.equal(
    doc.users.find((u: any) => u.name === alpha.context.user).user.token,
    'account-a-token',
    'alpha must still point at its own credentials',
  );

  const web = doc.contexts.find((c: any) => c.name === 'web');
  assert.equal(doc.clusters.find((c: any) => c.name === web.context.cluster).cluster.server, 'https://account-b');
  assert.equal(doc.users.find((u: any) => u.name === web.context.user).user.token, 'account-b-token');
});

test('mergeAksCredentialsIntoKubeconfig refuses to overwrite a target it cannot parse', async () => {
  // A truncated/corrupt kubeconfig is recoverable; silently replacing it with a fresh empty
  // one would destroy every context the user had imported.
  const target = await tmpPath('target.yaml');
  await fsp.writeFile(target, 'apiVersion: v1\nclusters: [ this is: not: valid yaml\n');
  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('my-cluster'));

  await assert.rejects(() => mergeAksCredentialsIntoKubeconfig(source, target, (n) => n));

  // Still on disk, untouched.
  const raw = await fsp.readFile(target, 'utf8');
  assert.match(raw, /not: valid yaml/);
});

test('mergeAksCredentialsIntoKubeconfig accepts an async resolveContextName', async () => {
  const target = await tmpPath('target.yaml');
  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('my-cluster'));

  const { contextName } = await mergeAksCredentialsIntoKubeconfig(source, target, async (defaultName) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `${defaultName}--async`;
  });
  assert.equal(contextName, 'my-cluster--async');

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.equal(doc.contexts[0].name, 'my-cluster--async');
});

test('mergeAksCredentialsIntoKubeconfig serializes concurrent merges to the same target file', async () => {
  const target = await tmpPath('target.yaml');
  const sourceA = await tmpPath('sourceA.yaml');
  const sourceB = await tmpPath('sourceB.yaml');
  await fsp.writeFile(sourceA, singleEntryKubeconfig('cluster-a'));
  await fsp.writeFile(sourceB, singleEntryKubeconfig('cluster-b'));

  await Promise.all([
    mergeAksCredentialsIntoKubeconfig(sourceA, target, (defaultName) => defaultName),
    mergeAksCredentialsIntoKubeconfig(sourceB, target, (defaultName) => defaultName),
  ]);

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.deepEqual(
    doc.contexts.map((c: any) => c.name).sort(),
    ['cluster-a', 'cluster-b'],
  );
});

test('removeContextsFromKubeconfigFile still removes a context added by the merge helper', async () => {
  const target = await tmpPath('target.yaml');
  const source = await tmpPath('source.yaml');
  await fsp.writeFile(source, singleEntryKubeconfig('my-cluster'));
  await mergeAksCredentialsIntoKubeconfig(source, target, (defaultName) => defaultName);

  const removed = await removeContextsFromKubeconfigFile(target, new Set(['my-cluster']));
  assert.equal(removed, true);

  const doc: any = yaml.load(await fsp.readFile(target, 'utf8'));
  assert.equal(doc.contexts.length, 0);
  assert.equal(doc.clusters.length, 0);
  assert.equal(doc.users.length, 0);
});
