import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidAvatarDataUrl, isValidEmail, validateOrgName } from './validation.js';

test('email validation rejects markup and control characters', () => {
  assert.equal(isValidEmail('operator@example.com'), true);
  assert.equal(isValidEmail('operator<script>@example.com'), false);
  assert.equal(isValidEmail('operator@example.com\nBcc: attacker@example.com'), false);
});

test('organization names are normalized and cannot be empty or oversized', () => {
  assert.equal(validateOrgName('  Platform\u0000 Team  '), 'Platform Team');
  assert.deepEqual(validateOrgName('\u200b'), { error: 'A team name is required' });
  assert.deepEqual(validateOrgName('a'.repeat(141)), { error: 'Team name must be 140 characters or fewer' });
});

test('avatar validation only accepts base64 image data URLs', () => {
  assert.equal(isValidAvatarDataUrl('data:image/png;base64,aGVsbG8='), true);
  assert.equal(isValidAvatarDataUrl('javascript:alert(1)'), false);
  assert.equal(isValidAvatarDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isValidAvatarDataUrl('data:image/png;base64,x" onerror="alert(1)'), false);
});
