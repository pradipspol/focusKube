import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdminEmail, isAdminUser } from './sessions.js';

test('admin allowlist matches normalized email addresses only', () => {
  const admins = ['owner@example.com', 'ops@example.com'];

  assert.equal(isAdminEmail(' OWNER@example.com ', admins), true);
  assert.equal(isAdminEmail('person@example.com', admins), false);
  assert.equal(isAdminEmail(null, admins), false);
  assert.equal(isAdminEmail('owner@example.com', []), false);
});

test('admin access requires a verified email on the allowlist', () => {
  const admins = ['owner@example.com'];

  assert.equal(isAdminUser({ email: 'OWNER@example.com', emailVerified: true }, admins), true);
  assert.equal(isAdminUser({ email: 'owner@example.com', emailVerified: false }, admins), false);
  assert.equal(isAdminUser({ email: 'other@example.com', emailVerified: true }, admins), false);
});