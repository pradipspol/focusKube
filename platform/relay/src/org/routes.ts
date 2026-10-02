import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireSession } from '../auth/sessions.js';
import { userService } from '../auth/userService.js';
import { isValidEmail, validateOrgName } from '../security/validation.js';
import { parseInterval } from '../billing/pricing.js';
import { activeProvider, BillingConfigError, isBillingConfigured } from '../billing/provider.js';
import { RazorpayError } from '../billing/razorpay.js';
import { config } from '../config.js';
import { getLicenseForUser } from '../licenseStore.js';
import { mongoCollections } from '../mongoCollections.js';
import { logError, logWarning } from '../logger.js';
import { sendOrgInviteEmail } from '../notify/email.js';
import { createOrgCheckoutSession, updateOrgSeats, cancelOrgSubscription, upgradeOrgToAnnual } from './billing.js';
import { getOrgLicenseForUser } from './entitlement.js';
import { OrgActionError } from './errors.js';
import { organizationService } from './organizationService.js';
import { isStripeDemoMode } from '../billing/stripe-sim.js';
import type { OrganizationRow } from './store.js';

const router = Router();
export const orgRouter = router;

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
 * authorization model for the org surface Ã¢â‚¬â€ no secondary admin role. */
async function requireOrgOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const org = await organizationService.findOrgByOwner(req.user!.id);
  if (!org) {
    res.status(403).json({ error: 'You do not own a team' });
    return;
  }
  req.org = org;
  next();
}

router.get('/', requireSession, async (req, res) => {
  const userId = req.user!.id;
  const ownedOrg = await organizationService.findOrgByOwner(userId);
  const ownedMembership = ownedOrg ? await organizationService.findMember(ownedOrg.id, userId) : undefined;
  const membership = ownedOrg ? undefined : await organizationService.findActiveMembership(userId);
  const org = ownedOrg ?? (membership ? await organizationService.findOrgById(membership.org_id) : undefined);

  if (!org) {
    res.json({ org: null, role: null, seats: null, license: null });
    return;
  }

  const role: 'owner' | 'member' = ownedOrg ? 'owner' : 'member';
  const teamPool = await mongoCollections.licenses.findOne(
    { org_id: org.id },
    { projection: { _id: 0, plan: 1, status: 1, quota_remaining: 1, quota_granted: 1, billing_interval: 1, billing_provider: 1, stripe_subscription_id: 1, stripe_subscription_item_id: 1 } },
  );
  let billingInterval = teamPool?.billing_interval ?? null;
  const billingProvider = activeProvider();
  if (
    teamPool && !billingInterval && teamPool.billing_provider === billingProvider.name &&
    billingProvider.supportsAnnualUpgrade() && billingProvider.isConfigured() && teamPool.stripe_subscription_id
  ) {
    try {
      billingInterval = await billingProvider.getSubscriptionInterval({
        subscriptionId: teamPool.stripe_subscription_id,
        subscriptionItemId: teamPool.stripe_subscription_item_id ?? null,
      });
      if (billingInterval) {
        await mongoCollections.licenses.updateOne({ org_id: org.id }, {
          $set: { billing_interval: billingInterval, updated_at: new Date().toISOString() },
        });
      }
    } catch (err) {
      logWarning('Could not resolve the existing team billing interval', { errorType: err instanceof Error ? err.name : typeof err });
    }
  }
  const base = {
    org: { id: org.id, name: org.name, status: org.status, createdAt: org.created_at },
    role,
    seatActive: ownedOrg ? ownedMembership?.status === 'active' : !!membership,
    seats: await organizationService.seatCounts(org.id),
    license: (await getOrgLicenseForUser(userId)) ?? null,
    teamPlan: teamPool ? {
      plan: teamPool.plan,
      status: teamPool.status,
      quotaRemaining: teamPool.quota_remaining,
      quotaGranted: teamPool.quota_granted,
      billingInterval,
    } : null,
  };

  if (role !== 'owner') {
    res.json(base);
    return;
  }

  res.json({
    ...base,
    members: (await organizationService.listActiveMembers(org.id)).map((m) => ({
      userId: m.user_id,
      email: m.email,
      firstName: m.first_name,
      lastName: m.last_name,
      role: m.role,
      joinedAt: m.joined_at,
      callsUsed: m.calls_used,
    })),
    invites: (await organizationService.listPendingInvites(org.id)).map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    })),
  });
});

router.post('/checkout', requireSession, async (req, res) => {
  if (!isBillingConfigured()) {
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
  const validatedName = validateOrgName(name);
  if (typeof validatedName !== 'string') {
    res.status(400).json(validatedName);
    return;
  }

  try {
    const result = await createOrgCheckoutSession(req.user!, {
      seats: seatCount,
      name: validatedName,
      interval: parseInterval(interval),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof OrgActionError || err instanceof RazorpayError || err instanceof BillingConfigError) {
      logWarning('Organization checkout could not be completed', { statusCode: err.status, errorType: err.name });
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post('/billing/annual', requireSession, requireOrgOwner, async (req, res) => {
  try {
    await upgradeOrgToAnnual(req.org!.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OrgActionError || err instanceof RazorpayError || err instanceof BillingConfigError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.patch('/', requireSession, requireOrgOwner, async (req, res) => {
  const { name } = req.body as { name?: string };
  const validatedName = validateOrgName(name);
  if (typeof validatedName !== 'string') {
    res.status(400).json(validatedName);
    return;
  }
  await organizationService.renameOrg(req.org!.id, validatedName);
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
    if (err instanceof OrgActionError || err instanceof RazorpayError || err instanceof BillingConfigError) {
      logWarning('Organization seat update could not be completed', { statusCode: err.status, errorType: err.name });
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post('/cancel-subscription', requireSession, requireOrgOwner, async (req, res) => {
  try {
    await cancelOrgSubscription(req.org!.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OrgActionError || err instanceof RazorpayError || err instanceof BillingConfigError) {
      logError('Organization subscription cancellation could not be completed', {
        statusCode: err.status,
        errorType: err.name,
      });
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post('/invites', requireSession, requireOrgOwner, async (req, res) => {
  const { email } = req.body as { email?: string };
  const normalized = email?.trim().toLowerCase();
  if (!isValidEmail(normalized)) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }

  const org = req.org!;
  if (org.status !== 'active') {
    res.status(409).json({ error: 'Your team subscription is not active' });
    return;
  }

  const demoInvitesEnabled = activeProvider().name === 'stripe' && isStripeDemoMode();
  if (!config.brevo.apiKey && !config.smtp.host && !config.smtp.url && !demoInvitesEnabled) {
    res.status(503).json({ error: 'Email delivery is not configured on this relay' });
    return;
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (await organizationService.countInvitesSince(org.id, oneHourAgo) >= config.org.maxInvitesPerHour) {
    res.status(429).json({ error: 'Too many invites sent Ã¢â‚¬â€ try again later' });
    return;
  }

  const counts = await organizationService.seatCounts(org.id);
  if (counts.filled + counts.pending >= counts.purchased) {
    res.status(409).json({ error: `All ${counts.purchased} seats are taken Ã¢â‚¬â€ add seats or revoke a pending invite first` });
    return;
  }

  const existingUser = await userService.findUserByEmail(normalized);
  if (existingUser) {
    const membership = await organizationService.findActiveMembership(existingUser.id);
    if (membership?.org_id === org.id) {
      res.status(409).json({ error: 'Already on your team' });
      return;
    }
    if (membership) {
      res.status(409).json({ error: 'That person is already on another team' });
      return;
    }
  }
  if (await organizationService.findPendingInviteForEmail(org.id, normalized)) {
    res.status(409).json({ error: 'Already invited Ã¢â‚¬â€ use Resend instead' });
    return;
  }

  const created = await organizationService.createInviteWithAvailableSeat(org.id, normalized, req.user!.id);
  if ('error' in created) {
    res.status(409).json({ error: created.error });
    return;
  }
  const invite = created.invite;
  const inviterLabel = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ') || req.user!.email || 'Someone';
  await sendOrgInviteEmail(normalized, invite.token, org.name, inviterLabel);
  const demoInviteUrl = demoInvitesEnabled
    ? `${config.publicUrl.replace(/\/+$/, '')}/invite?token=${encodeURIComponent(invite.token)}`
    : undefined;
  res.json({ ok: true, id: invite.id, expiresAt: invite.expiresAt, ...(demoInviteUrl ? { demoInviteUrl } : {}) });
});

router.post('/invites/:id/resend', requireSession, requireOrgOwner, async (req, res) => {
  const invite = (await organizationService.listPendingInvites(req.org!.id)).find((i) => i.id === req.params.id);
  if (!invite) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  const rotated = await organizationService.resendInvite(req.org!.id, invite.id);
  if (!rotated) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  const inviterLabel = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ') || req.user!.email || 'Someone';
  await sendOrgInviteEmail(invite.email, rotated.token, req.org!.name, inviterLabel);
  const demoInviteUrl = activeProvider().name === 'stripe' && isStripeDemoMode()
    ? `${config.publicUrl.replace(/\/+$/, '')}/invite?token=${encodeURIComponent(rotated.token)}`
    : undefined;
  res.json({ ok: true, expiresAt: rotated.expiresAt, ...(demoInviteUrl ? { demoInviteUrl } : {}) });
});

router.delete('/invites/:id', requireSession, requireOrgOwner, async (req, res) => {
  const result = await organizationService.revokeInvite(req.org!.id, req.params.id);
  if (result === 'busy') {
    res.status(409).json({ error: 'A team seat is being assigned. Please try again shortly.' });
    return;
  }
  if (result === 'not-found') {
    res.status(404).json({ error: 'Pending invite not found' });
    return;
  }
  res.json({ ok: true });
});

router.get('/invites/by-token/:token', publicInviteLimiter, async (req, res) => {
  const invite = await organizationService.findInviteByToken(req.params.token);
  if (!invite || invite.status !== 'pending') {
    res.status(404).json({ error: 'This invite is invalid or has expired' });
    return;
  }
  const [org, inviteUser] = await Promise.all([organizationService.findOrgById(invite.org_id), userService.findUserByEmail(invite.email)]);
  res.json({
    orgName: org?.name ?? 'a team',
    email: invite.email,
    expiresAt: invite.expires_at,
    accountExists: !!inviteUser,
  });
});

router.post('/invites/by-token/:token/accept', requireSession, publicInviteLimiter, async (req, res) => {
  const invite = await organizationService.findInviteByToken(req.params.token);
  if (!invite || invite.status !== 'pending') {
    res.status(400).json({ error: 'This invite is invalid or has expired' });
    return;
  }

  const user = req.user!;
  // The token was mailed to this exact address Ã¢â‚¬â€ requiring a match keeps seat accounting
  // predictable and stops invite forwarding. Possession of the token is later trusted as
  // proof of ownership the same way auth/routes.ts already trusts a verified OTP.
  if (!user.email || user.email.toLowerCase() !== invite.email) {
    res.status(403).json({ error: `This invite was sent to ${invite.email} Ã¢â‚¬â€ sign in with that address to accept it` });
    return;
  }
  const org = await organizationService.findOrgById(invite.org_id);
  if (!org || org.status !== 'active') {
    res.status(409).json({ error: 'This team is not currently active' });
    return;
  }
  if (await organizationService.hasActiveSeatElsewhere(user.id, org.id)) {
    res.status(409).json({ error: "You're already on another team" });
    return;
  }

  const rejected = await organizationService.claimInviteSeat(invite, org.id, user.id, user.emailVerified);

  if (rejected) {
    res.status(409).json({ error: rejected });
    return;
  }

  const personal = await getLicenseForUser(user.id);
  const warning =
    personal?.status === 'active' && personal.plan !== 'trial'
      ? 'You still have a personal Pro subscription Ã¢â‚¬â€ cancel it from Account if you no longer need it'
      : undefined;
  res.json({ ok: true, orgId: org.id, warning });
});

router.delete('/members/:userId', requireSession, requireOrgOwner, async (req, res) => {
  if (req.params.userId === req.user!.id) {
    res.status(403).json({ error: 'Use the leave-team action to give up your seat while keeping team ownership' });
    return;
  }
  await organizationService.removeMember(req.org!.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/seat/join', requireSession, requireOrgOwner, async (req, res) => {
  const error = await organizationService.claimOwnerSeat(req.org!.id, req.user!.id);
  if (error) {
    res.status(409).json({ error });
    return;
  }
  res.json({ ok: true });
});

router.post('/leave', requireSession, async (req, res) => {
  const membership = await organizationService.findActiveMembership(req.user!.id);
  if (!membership) {
    res.status(400).json({ error: "You're not on a team" });
    return;
  }
  await organizationService.removeMember(membership.org_id, req.user!.id);
  res.json({ ok: true });
});

// A member's own seat key rotation Ã¢â‚¬â€ the Team counterpart to account/routes.ts's
// POST /license/regenerate, which is scope-aware and delegates here for a Team member.
router.post('/seat/key/regenerate', requireSession, async (req, res) => {
  const membership = await organizationService.findActiveMembership(req.user!.id);
  if (!membership) {
    res.status(400).json({ error: "You're not on a team" });
    return;
  }
  const key = await organizationService.regenerateMemberKey(membership.id);
  res.json({ key });
});
