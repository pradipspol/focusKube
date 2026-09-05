import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// `config.ts` reads SESSION_STORAGE_DIR once, at first import, into a module-level singleton -
// setting it here (a plain statement, not a static import) runs before the dynamic import below
// triggers that first load, so this whole file's data stays isolated from the real app's
// session storage on disk.
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'azure-account-store-test-'));
process.env.SESSION_STORAGE_DIR = tmpRoot;

const { allocateCandidateAzureConfigDir, registerOrPromoteAzureAccount, getAzureAccountConfigDir, deregisterAzureAccount, listAzureAccounts } =
  await import('./azureAccountStore.js');

function uniqueUserId(): string {
  return `user-${crypto.randomUUID()}`;
}

test('registers a brand new account and exposes its config dir', async () => {
  const userId = uniqueUserId();
  const candidate = await allocateCandidateAzureConfigDir(userId);
  const record = await registerOrPromoteAzureAccount(userId, 'Prapol@ptc.com', candidate.configDirName);
  assert.equal(record.accountId, 'prapol@ptc.com');
  assert.equal(record.email, 'Prapol@ptc.com');

  const dir = await getAzureAccountConfigDir(userId, 'prapol@ptc.com');
  assert.equal(dir, candidate.dir);

  const accounts = await listAzureAccounts(userId);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, 'prapol@ptc.com');
});

test('reconnecting an existing account promotes the new dir and cleans up the old one', async () => {
  const userId = uniqueUserId();
  const first = await allocateCandidateAzureConfigDir(userId);
  await registerOrPromoteAzureAccount(userId, 'sghosh@ptc.com', first.configDirName);
  await fsp.stat(first.dir); // exists

  const second = await allocateCandidateAzureConfigDir(userId);
  await registerOrPromoteAzureAccount(userId, 'sghosh@ptc.com', second.configDirName);
  const secondDir = await getAzureAccountConfigDir(userId, 'sghosh@ptc.com');
  assert.equal(secondDir, second.dir);

  await assert.rejects(() => fsp.stat(first.dir)); // old dir cleaned up
});

test('two different accounts get independent, non-colliding config dirs', async () => {
  const userId = uniqueUserId();
  const a = await allocateCandidateAzureConfigDir(userId);
  await registerOrPromoteAzureAccount(userId, 'prapol@ptc.com', a.configDirName);
  const b = await allocateCandidateAzureConfigDir(userId);
  await registerOrPromoteAzureAccount(userId, 'sghosh@ptc.com', b.configDirName);

  const dirA = await getAzureAccountConfigDir(userId, 'prapol@ptc.com');
  const dirB = await getAzureAccountConfigDir(userId, 'sghosh@ptc.com');
  assert.notEqual(dirA, dirB);
});

test('deregisterAzureAccount removes the record and its config dir', async () => {
  const userId = uniqueUserId();
  const candidate = await allocateCandidateAzureConfigDir(userId);
  await registerOrPromoteAzureAccount(userId, 'prapol@ptc.com', candidate.configDirName);
  await deregisterAzureAccount(userId, 'prapol@ptc.com');

  assert.equal(await getAzureAccountConfigDir(userId, 'prapol@ptc.com'), undefined);
  assert.equal((await listAzureAccounts(userId)).length, 0);
  await assert.rejects(() => fsp.stat(candidate.dir));
});
