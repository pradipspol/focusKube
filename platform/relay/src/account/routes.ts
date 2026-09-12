import { Router } from 'express';
import { requireSession, revokeAllSessionsForUser, clearSessionCookie } from '../auth/sessions.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  findUserByEmail,
  findUserById,
  setEmail,
  setPassword,
  setTwoFactorEnabled,
  softDeleteUser,
  updateProfile,
} from '../auth/users.js';
import { createLicenseForUser, getLicenseForUser, grantFreeTrial, hasHadTrial } from '../licenseStore.js';
import { getEffectiveLicenseForUser } from '../org/entitlement.js';
import { findActiveMembership, findOrgByOwner, regenerateMemberKey, removeMember } from '../org/store.js';
import { db } from '../db.js';

const router = Router();
export const accountRouter = router;

router.get('/', requireSession, (req, res) => {
  const license = getEffectiveLicenseForUser(req.user!.id);
  res.json({
    user: req.user,
    license: license ?? null,
    personalLicense: getLicenseForUser(req.user!.id) ?? null,
    hasHadTrial: hasHadTrial(req.user!.id),
  });
});

// Rotates the user's key (e.g. if it leaked) without touching plan/quota/Stripe linkage.
// Scope-aware: a Team member rotates only their own seat key (not a personal license
// carrying the pool's entire quota — see org/entitlement.ts's precedence note).
router.post('/license/regenerate', requireSession, (req, res) => {
  const effective = getEffectiveLicenseForUser(req.user!.id);
  if (!effective) {
    res.status(400).json({ error: 'No active plan to regenerate a key for' });
    return;
  }
  if (effective.scope === 'org') {
    const membership = findActiveMembership(req.user!.id);
    const key = regenerateMemberKey(membership!.id);
    res.json({ key });
    return;
  }
  const key = createLicenseForUser(req.user!.id, { plan: effective.plan, quotaRemaining: effective.quotaRemaining });
  res.json({ key });
});

// The deliberate, user-initiated free trial — one per account, ever (see
// licenseStore.ts's grantFreeTrial). Distinct from billing/routes.ts's checkout
// fallback, which is a self-host/dev convenience with no such limit.
router.post('/trial/start', requireSession, (req, res) => {
  const effective = getEffectiveLicenseForUser(req.user!.id);
  if (effective?.scope === 'org' && effective.status === 'active') {
    res.status(409).json({ error: `You're covered by ${effective.org!.name}'s team plan` });
    return;
  }
  const result = grantFreeTrial(req.user!.id);
  if ('alreadyUsed' in result) {
    res.status(409).json({ error: 'You have already used your free trial' });
    return;
  }
  res.json({ trialGranted: true, license: getLicenseForUser(req.user!.id) });
});

router.post('/license/cancel', requireSession, (req, res) => {
  const license = getLicenseForUser(req.user!.id);
  if (!license || license.plan !== 'trial') {
    res.status(400).json({ error: 'No active trial to cancel' });
    return;
  }
  // Mark the trial as inactive so it won't show up anymore
  db.prepare(`UPDATE licenses SET status = 'inactive', updated_at = ? WHERE user_id = ?`).run(
    new Date().toISOString(),
    req.user!.id,
  );
  res.json({ cancelled: true });
});

router.get('/profile', requireSession, (req, res) => {
  res.json({ user: req.user });
});

// The base64 data URL an uploaded avatar arrives as inflates ~1.37x over the raw file —
// this caps the *encoded* string, so a real image file must stay well under 1MB.
const MAX_AVATAR_DATA_URL_LENGTH = 1_400_000;

router.patch('/profile', requireSession, (req, res) => {
  const { firstName, lastName, company, avatarDataUrl, productUpdatesOptIn } = req.body as {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    avatarDataUrl?: string | null;
    productUpdatesOptIn?: boolean;
  };

  if (typeof avatarDataUrl === 'string' && avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    res.status(400).json({ error: 'Image is too large — please use a file under 1MB' });
    return;
  }

  const trim = (value: string | null | undefined): string | null | undefined =>
    typeof value === 'string' ? value.trim() || null : value;

  updateProfile(req.user!.id, {
    firstName: trim(firstName),
    lastName: trim(lastName),
    company: trim(company),
    avatarDataUrl,
    productUpdatesOptIn,
  });
  res.json({ ok: true });
});

router.post('/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({ error: 'A new password of at least 8 characters is required' });
    return;
  }
  const user = findUserById(req.user!.id)!;
  if (user.password_hash) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
  }
  setPassword(user.id, await hashPassword(newPassword));
  res.json({ ok: true });
});

// "Username" here is the account's email — the identifier used to log in — so this is a
// straight rename, not a separate handle. Re-verification isn't wired up yet (there's no
// email-verification flow anywhere else in the relay either), so the new address is
// accepted immediately and simply marked unverified, same as any other email change.
router.post('/email', requireSession, async (req, res) => {
  const { newEmail, currentPassword } = req.body as { newEmail?: string; currentPassword?: string };
  const normalized = newEmail?.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  const user = findUserById(req.user!.id)!;
  if (user.password_hash) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
  }
  const existing = findUserByEmail(normalized);
  if (existing && existing.id !== user.id) {
    res.status(409).json({ error: 'Another account already uses this email' });
    return;
  }
  setEmail(user.id, normalized, false);
  res.json({ ok: true });
});

// Only meaningful for password-based sign-in — see auth/routes.ts's POST /login, which is
// the one path that checks this flag and demands the extra emailed code.
router.post('/2fa', requireSession, (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (enabled) {
    if (!req.user!.hasPassword) {
      res.status(400).json({ error: 'Set a password before enabling two-factor authentication' });
      return;
    }
    if (!req.user!.email) {
      res.status(400).json({ error: 'Add an email to your account before enabling two-factor authentication' });
      return;
    }
  }
  setTwoFactorEnabled(req.user!.id, !!enabled);
  res.json({ ok: true, twoFactorEnabled: !!enabled });
});

// Soft delete (see users.ts's softDeleteUser): signs the account out everywhere and
// deactivates its license immediately, but keeps the row for a recovery window rather
// than erasing it on the spot.
router.post('/delete', requireSession, (req, res) => {
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== 'DELETE') {
    res.status(400).json({ error: 'Type DELETE to confirm account removal' });
    return;
  }
  const userId = req.user!.id;

  // Deleting the owner of an active team would orphan it — no one left able to manage
  // seats/billing/members (owner-only admin, no secondary role in v1).
  const ownedOrg = findOrgByOwner(userId);
  if (ownedOrg && ownedOrg.status === 'active') {
    res.status(409).json({ error: 'Cancel your team subscription before deleting your account' });
    return;
  }

  // A seated member's key must stop working immediately — softDeleteUser only marks the
  // user row deleted, so without this the organization_members row (and its seat key)
  // would silently keep passing lookupLicense forever.
  const membership = findActiveMembership(userId);
  if (membership) {
    removeMember(membership.org_id, userId);
  }

  softDeleteUser(userId);
  db.prepare(`UPDATE licenses SET status = 'inactive', updated_at = ? WHERE user_id = ?`).run(
    new Date().toISOString(),
    userId,
  );
  revokeAllSessionsForUser(userId);
  clearSessionCookie(res);
  res.json({ ok: true });
});
