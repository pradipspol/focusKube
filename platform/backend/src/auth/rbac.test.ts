import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  capabilityForMethod,
  guardByMethod,
  hasCapability,
  isRole,
  normalizeRole,
  requireCapability,
} from './rbac.js';
import { HttpError } from '../util/httpError.js';

test('isRole recognizes known roles only', () => {
  assert.equal(isRole('admin'), true);
  assert.equal(isRole('editor'), true);
  assert.equal(isRole('rwonly'), true);
  assert.equal(isRole('viewer'), true);
  assert.equal(isRole('superuser'), false);
  assert.equal(isRole(undefined), false);
});

test('normalizeRole falls back to viewer for unknown values', () => {
  assert.equal(normalizeRole('editor'), 'editor');
  assert.equal(normalizeRole('nope'), 'viewer');
  assert.equal(normalizeRole(undefined), 'viewer');
});

test('hasCapability reflects each role\'s permitted actions', () => {
  assert.equal(hasCapability('admin', 'admin'), true);
  assert.equal(hasCapability('editor', 'delete'), true);
  assert.equal(hasCapability('editor', 'admin'), false);
  assert.equal(hasCapability('rwonly', 'write'), true);
  assert.equal(hasCapability('rwonly', 'delete'), false);
  assert.equal(hasCapability('viewer', 'write'), false);
  assert.equal(hasCapability(null, 'read'), false);
});

test('capabilityForMethod maps HTTP methods to capabilities', () => {
  assert.equal(capabilityForMethod('GET'), 'read');
  assert.equal(capabilityForMethod('HEAD'), 'read');
  assert.equal(capabilityForMethod('OPTIONS'), 'read');
  assert.equal(capabilityForMethod('DELETE'), 'delete');
  assert.equal(capabilityForMethod('POST'), 'write');
  assert.equal(capabilityForMethod('PUT'), 'write');
  assert.equal(capabilityForMethod('PATCH'), 'write');
});

function makeReq(authUser: { role: string } | null): Request {
  return { authUser, method: 'POST' } as unknown as Request;
}

test('requireCapability throws 401 when unauthenticated', () => {
  const middleware = requireCapability('write');
  assert.throws(() => middleware(makeReq(null), {} as Response, () => {}), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 401);
    return true;
  });
});

test('requireCapability throws 403 when the role lacks the capability', () => {
  const middleware = requireCapability('delete');
  assert.throws(() => middleware(makeReq({ role: 'viewer' }), {} as Response, () => {}), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    return true;
  });
});

test('requireCapability calls next() when the role has the capability', () => {
  const middleware = requireCapability('read');
  let called = false;
  middleware(makeReq({ role: 'viewer' }), {} as Response, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('guardByMethod infers capability from method and blocks read-only roles from writes', () => {
  assert.throws(() => guardByMethod(makeReq({ role: 'viewer' }), {} as Response, () => {}), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    return true;
  });
});

test('guardByMethod allows editors to write', () => {
  let called = false;
  guardByMethod(makeReq({ role: 'editor' }), {} as Response, () => {
    called = true;
  });
  assert.equal(called, true);
});
