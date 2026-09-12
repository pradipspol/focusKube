import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireSession } from '../auth/sessions.js';
import { findUserByEmail, markEmailVerified } from '../auth/users.js';
import { parseInterval } from '../billing/pricing.js';
import { isStripeConfigured } from '../billing/stripe.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { getLicenseForUser } from '../licenseStore.js';
import { sendOrgInviteEmail } from '../notify/email.js';
import { createOrgCheckoutSession, updateOrgSeats } from './billing.js';
import { getOrgLicenseForUser } from './entitlement.js';
import { OrgActionError } from './errors.js';
import {
  countInvitesSince,
  createInvite,
  findActiveMembership,
  findInviteByToken,
  findOrgById,
  findOrgByOwner,
  findPendingInviteForEmail,
  hasActiveSeatElsewhere,
  listActiveMembers,
  listPendingInvites,
  markInviteAccepted,
  regenerateMemberKey,
  removeMember,
  renameOrg,
  resendInvite,
  revokeInvite,
  seatCounts,
  seatUser,
  type OrganizationRow,
} from './store.js';

const router = Router();
export const orgRouter = router;

// Deliberately permissive, same rationale as auth/routes.ts's own EMAIL_RE — a coarse
// server-side sanity check, not the source of truth for "is this a real address."
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      org?: OrganizationRow;
    }
  }
}

/** 403s unless req.user owns a team, and attaches it as req.org. The entire v1
 * authorization model for the org surface — no secondary admin role. */
function requireOrgOwner(req: Request, res: Response, next: NextFunction): void {
  const org = findOrgByOwner(req.user!.id);
  if (!org) {
    res.status(403).json({ error: 'You do not own a team' });
    return;
  }
  req.org = org;
  next();
}

router.get('/', requireSession, (req, res) => {
  const userId = req.user!.id;
  const ownedOrg = findOrgByOwner(userId);
  const membership = ownedOrg ? undefined : findActiveMembership(userId);
  const org = ownedOrg ?? (membership ? findOrgById(membership.org_id) : undefined);

  if (!org) {
    res.json({ org: null, role: null, seats: null, license: null });
    return;
  }

  const role: 'owner' | 'member' = ownedOrg ? 'owner' : 'member';
  const base = {
    org: { id: org.id, name: org.name, status: org.status, createdAt: org.created_at },
    role,
    seats: seatCounts(org.id),
    license: getOrgLicenseForUser(userId) ?? null,
  };

  if (role !== 'owner') {
    res.json(base);
    return;
  }

  res.json({
    ...base,
    members: listActiveMembers(org.id).map((m) => ({
      userId: m.user_id,
      email: m.email,
      firstName: m.first_name,
      lastName: m.last_name,
      role: m.role,
      joinedAt: m.joined_at,
      callsUsed: m.calls_used,
    })),
    invites: listPendingInvites(org.id).map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    })),
  });
});

router.post('/checkout', requireSession, async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: 'Team plans require billing to be configured on this server' });
    return;
  }
  // Same rationale as billing/routes.ts's individual checkout: Stripe needs somewhere to
  // send receipts, and this rules out inviting the wrong address by typo.
  if (!req.user!.email || !req.user!.emailVerified) {
    res.status(400).json({ error: 'Verify your email before starting a team subscription' });
    return;
  }

  const { seats, name, interval } = req.body as { seats?: number; name?: string; interval?: string };
  const seatCount = Number(seats);
  if (!Number.isInteger(seatCount) || seatCount < config.org.minSeats || seatCount > config.org.maxSeats) {
    res.status(400).json({ error: `Seats must be between ${config.org.minSeats} and ${config.org.maxSeats}` });
    return;
  }
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'A team name is required' });
    return;
  }

  try {
    const result = await createOrgCheckoutSession(req.user!, {
      seats: seatCount,
      name: name.trim(),
      interval: parseInterval(interval),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof OrgActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.patch('/', requireSession, requireOrgOwner, (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'A team name is required' });
    return;
  }
  renameOrg(req.org!.id, name.trim());
  res.json({ ok: true });
});

router.post('/seats', requireSession, requireOrgOwner, async (req, res) => {
  const { seats } = req.body as { seats?: number };
  const seatCount = Number(seats);
  if (!Number.isInteger(seatCount)) {
    res.status(400).json({ error: 'seats must be a number' });
    return;
  }
  try {
    await updateOrgSeats(req.org!.id, seatCount);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OrgActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post('/invites', requireSession, requireOrgOwner, async (req, res) => {
  const { email } = req.body as { email?: string };
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !EMAIL_RE.test(normalized)) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }

  const org = req.org!;
  if (org.status !== 'active') {
    res.status(409).json({ error: 'Your team subscription is not active' });
    return;
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (countInvitesSince(org.id, oneHourAgo) >= config.org.maxInvitesPerHour) {
    res.status(429).json({ error: 'Too many invites sent — try again later' });
    return;
  }

  const counts = seatCounts(org.id);
  if (counts.filled + counts.pending >= counts.purchased) {
    res.status(409).json({ error: `All ${counts.purchased} seats are taken — add seats or revoke a pending invite first` });
    return;
  }

  const existingUser = findUserByEmail(normalized);
  if (existingUser) {
    const membership = findActiveMembership(existingUser.id);
    if (membership?.org_id === org.id) {
      res.status(409).json({ error: 'Already on your team' });
      return;
    }
    if (membership) {
      res.status(409).json({ error: 'That person is already on another team' });
      return;
    }
  }
  if (findPendingInviteForEmail(org.id, normalized)) {
    res.status(409).json({ error: 'Already invited — use Resend instead' });
    return;
  }

  const invite = createInvite(org.id, normalized, req.user!.id);
  const inviterLabel = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ') || req.user!.email || 'Someone';
  await sendOrgInviteEmail(normalized, invite.token, org.name, inviterLabel);
  res.json({ ok: true, id: invite.id, expiresAt: invite.expiresAt });
});

router.post('/invites/:id/resend', requireSession, requireOrgOwner, async (req, res) => {
  const invite = listPendingInvites(req.org!.id).find((i) => i.id === req.params.id);
  if (!invite) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  const rotated = resendInvite(invite.id);
  const inviterLabel = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ') || req.user!.email || 'Someone';
  await sendOrgInviteEmail(invite.email, rotated.token, req.org!.name, inviterLabel);
  res.json({ ok: true, expiresAt: rotated.expiresAt });
});

router.delete('/invites/:id', requireSession, requireOrgOwner, (req, res) => {
  revokeInvite(req.params.id);
  res.json({ ok: true });
});

router.get('/invites/by-token/:token', publicInviteLimiter, (req, res) => {
  const invite = findInviteByToken(req.params.token);
  if (!invite || invite.status !== 'pending') {
    res.status(404).json({ error: 'This invite is invalid or has expired' });
    return;
  }
  const org = findOrgById(invite.org_id);
  res.json({
    orgName: org?.name ?? 'a team',
    email: invite.email,
    expiresAt: invite.expires_at,
    accountExists: !!findUserByEmail(invite.email),
  });
});

router.post('/invites/by-token/:token/accept', requireSession, publicInviteLimiter, (req, res) => {
  const invite = findInviteByToken(req.params.token);
  if (!invite || invite.status !== 'pending') {
    res.status(400).json({ error: 'This invite is invalid or has expired' });
    return;
  }

  const user = req.user!;
  // The token was mailed to this exact address — requiring a match keeps seat accounting
  // predictable and stops invite forwarding. Possession of the token is later trusted as
  // proof of ownership the same way auth/routes.ts already trusts a verified OTP.
  if (!user.email || user.email.toLowerCase() !== invite.email) {
    res.status(403).json({ error: `This invite was sent to ${invite.email} — sign in with that address to accept it` });
    return;
  }
  const org = findOrgById(invite.org_id);
  if (!org || org.status !== 'active') {
    res.status(409).json({ error: 'This team is not currently active' });
    return;
  }
  if (hasActiveSeatElsewhere(user.id, org.id)) {
    res.status(409).json({ error: "You're already on another team" });
    return;
  }

  // Re-check seat availability inside the same transaction as the insert, so two people
  // can't both claim the last seat.
  let rejected: string | undefined;
  db.transaction(() => {
    const counts = seatCounts(org.id);
    if (counts.filled >= counts.purchased) {
      rejected = `All ${counts.purchased} seats are taken`;
      return;
    }
    seatUser(org.id, user.id, 'member', invite.invited_by_user_id);
    markInviteAccepted(invite.id, user.id);
    if (!user.emailVerified) markEmailVerified(user.id);
  })();

  if (rejected) {
    res.status(409).json({ error: rejected });
    return;
  }

  const personal = getLicenseForUser(user.id);
  const warning =
    personal?.status === 'active' && personal.plan !== 'trial'
      ? 'You still have a personal Pro subscription — cancel it from Account if you no longer need it'
      : undefined;
  res.json({ ok: true, orgId: org.id, warning });
});

router.delete('/members/:userId', requireSession, requireOrgOwner, (req, res) => {
  if (req.params.userId === req.user!.id) {
    res.status(403).json({ error: 'Cancel the subscription from billing instead' });
    return;
  }
  removeMember(req.org!.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/leave', requireSession, (req, res) => {
  const membership = findActiveMembership(req.user!.id);
  if (!membership) {
    res.status(400).json({ error: "You're not on a team" });
    return;
  }
  if (membership.role === 'owner') {
    res.status(403).json({ error: 'The owner cannot leave — cancel the subscription instead' });
    return;
  }
  removeMember(membership.org_id, req.user!.id);
  res.json({ ok: true });
});

// A member's own seat key rotation — the Team counterpart to account/routes.ts's
// POST /license/regenerate, which is scope-aware and delegates here for a Team member.
router.post('/seat/key/regenerate', requireSession, (req, res) => {
  const membership = findActiveMembership(req.user!.id);
  if (!membership) {
    res.status(400).json({ error: "You're not on a team" });
    return;
  }
  const key = regenerateMemberKey(membership.id);
  res.json({ key });
});
