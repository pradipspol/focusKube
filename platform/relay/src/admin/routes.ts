import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { mongoCollections } from '../mongoCollections.js';
import { sendAdminInviteEmail } from '../notify/email.js';
import { isValidEmail } from '../security/validation.js';
import { isAdminUser, requireAdmin, requireSession } from '../auth/sessions.js';

const router = Router();
export const adminRouter = router;

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

router.get('/access', requireSession, (req, res) => {
  res.json({ isAdmin: isAdminUser(req.user) });
});

router.use(requireSession, requireAdmin);

router.get('/overview', async (_req, res) => {
  const users = mongoCollections.users;
  const licenses = mongoCollections.licenses;
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [totalUsers, deletedUsers, verifiedUsers, newUsersLast30Days, activeTrials, activeSubscriptions, organizations, pendingInvites, creditTotals] = await Promise.all([
    users.countDocuments({ deleted_at: null }),
    users.countDocuments({ deleted_at: { $ne: null } }),
    users.countDocuments({ deleted_at: null, email_verified: 1 }),
    users.countDocuments({ deleted_at: null, created_at: { $gte: monthAgo } }),
    licenses.countDocuments({ plan: 'trial', status: 'active' }),
    licenses.countDocuments({ plan: { $nin: ['dev', 'trial'] }, status: 'active' }),
    mongoCollections.organizations.countDocuments({}),
    mongoCollections.organization_invites.countDocuments({ status: 'pending', expires_at: { $gt: now.toISOString() } }),
    licenses.aggregate<{ remaining: number; granted: number }>([
      { $match: { status: 'active', plan: { $ne: 'dev' } } },
      { $group: { _id: null, remaining: { $sum: '$quota_remaining' }, granted: { $sum: '$quota_granted' } } },
    ]).toArray(),
  ]);

  res.json({
    totalUsers,
    deletedUsers,
    verifiedUsers,
    newUsersLast30Days,
    activeTrials,
    activeSubscriptions,
    organizations,
    pendingInvites,
    creditsRemaining: creditTotals[0]?.remaining ?? 0,
    creditsGranted: creditTotals[0]?.granted ?? 0,
  });
});

router.get('/telemetry', async (_req, res) => {
  const [planUsage, teamUsage] = await Promise.all([
    mongoCollections.licenses.aggregate<{
      _id: { plan: string; status: string };
      licenses: number;
      creditsGranted: number;
      creditsRemaining: number;
      creditsConsumed: number;
    }>([
      { $match: { plan: { $ne: 'dev' } } },
      { $group: {
        _id: { plan: '$plan', status: '$status' },
        licenses: { $sum: 1 },
        creditsGranted: { $sum: '$quota_granted' },
        creditsRemaining: { $sum: '$quota_remaining' },
        creditsConsumed: { $sum: { $max: [{ $subtract: ['$quota_granted', '$quota_remaining'] }, 0] } },
      } },
      { $sort: { '_id.plan': 1, '_id.status': 1 } },
    ]).toArray(),
    mongoCollections.organization_members.aggregate<{ _id: null; activeMembers: number; teamCallsUsed: number }>([
      { $match: { status: 'active' } },
      { $group: { _id: null, activeMembers: { $sum: 1 }, teamCallsUsed: { $sum: '$calls_used' } } },
    ]).toArray(),
  ]);

  res.json({
    plans: planUsage.map((row) => ({
      plan: row._id.plan,
      status: row._id.status,
      licenses: row.licenses,
      creditsGranted: row.creditsGranted,
      creditsRemaining: row.creditsRemaining,
      creditsConsumed: row.creditsConsumed,
    })),
    activeTeamMembers: teamUsage[0]?.activeMembers ?? 0,
    teamCallsUsed: teamUsage[0]?.teamCallsUsed ?? 0,
  });
});

router.get('/teams', async (_req, res) => {
  const organizations = await mongoCollections.organizations.find({}, {
    projection: { id: 1, name: 1, owner_user_id: 1, status: 1, seats_purchased: 1, created_at: 1 },
  }).sort({ created_at: -1 }).limit(100).toArray();
  const orgIds = organizations.map((org) => org.id);
  const ownerIds = [...new Set(organizations.map((org) => org.owner_user_id))];
  const [owners, memberCounts, pendingInvites, totalTeams] = await Promise.all([
    ownerIds.length
      ? mongoCollections.users.find({ id: { $in: ownerIds } }, { projection: { id: 1, email: 1, first_name: 1, last_name: 1 } }).toArray()
      : Promise.resolve([]),
    orgIds.length
      ? mongoCollections.organization_members.aggregate<{ _id: string; count: number }>([
        { $match: { org_id: { $in: orgIds }, status: 'active' } },
        { $group: { _id: '$org_id', count: { $sum: 1 } } },
      ]).toArray()
      : Promise.resolve([]),
    orgIds.length
      ? mongoCollections.organization_invites.aggregate<{ _id: string; count: number }>([
        { $match: { org_id: { $in: orgIds }, status: 'pending', expires_at: { $gt: new Date().toISOString() } } },
        { $group: { _id: '$org_id', count: { $sum: 1 } } },
      ]).toArray()
      : Promise.resolve([]),
    mongoCollections.organizations.countDocuments({}),
  ]);
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const membersByOrg = new Map(memberCounts.map((row) => [row._id, row.count]));
  const invitesByOrg = new Map(pendingInvites.map((row) => [row._id, row.count]));

  res.json({
    total: totalTeams,
    teams: organizations.map((org) => {
      const owner = ownerById.get(org.owner_user_id);
      return {
        id: org.id,
        name: org.name,
        status: org.status,
        createdAt: org.created_at,
        seatsPurchased: org.seats_purchased,
        activeMembers: membersByOrg.get(org.id) ?? 0,
        pendingInvites: invitesByOrg.get(org.id) ?? 0,
        ownerName: [owner?.first_name, owner?.last_name].filter(Boolean).join(' ') || null,
        ownerEmail: owner?.email ?? null,
      };
    }),
  });
});

router.get('/users', async (req, res) => {
  const requestedPage = Number.parseInt(String(req.query.page ?? '1'), 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const requestedPageSize = Number.parseInt(String(req.query.pageSize ?? '25'), 10);
  const pageSize = [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25;
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = query
    ? {
      deleted_at: null,
      $or: ['email', 'phone', 'first_name', 'last_name'].map((field) => ({
        [field]: { $regex: escapedQuery, $options: 'i' },
      })),
    }
    : { deleted_at: null };
  const inviteFilter = query
    ? { status: 'pending' as const, email: { $regex: escapedQuery, $options: 'i' } }
    : { status: 'pending' as const };
  const [rows, total, pendingInviteRows] = await Promise.all([
    mongoCollections.users.find(filter, {
      projection: {
        id: 1, email: 1, phone: 1, first_name: 1, last_name: 1, company: 1,
        email_verified: 1, two_factor_enabled: 1, trial_started_at: 1, created_at: 1,
      },
    }).sort({ created_at: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    mongoCollections.users.countDocuments(filter),
    mongoCollections.admin_invites.find(inviteFilter, {
      projection: { id: 1, email: 1, invited_at: 1 },
    }).sort({ invited_at: -1 }).limit(100).toArray(),
  ]);
  const ids = rows.map((user) => user.id);
  const emails = rows.map((user) => user.email).filter((email): email is string => !!email);
  const pendingEmails = pendingInviteRows.map((invite) => invite.email);
  const [licenseRows, registeredInvites, registeredPendingUsers] = await Promise.all([
    ids.length
      ? mongoCollections.licenses.find({ user_id: { $in: ids } }, {
      projection: { user_id: 1, plan: 1, status: 1, quota_remaining: 1, quota_granted: 1 },
      }).toArray()
      : Promise.resolve([]),
    emails.length
      ? mongoCollections.admin_invites.find({ status: { $in: ['pending', 'registered'] }, email: { $in: emails } }, { projection: { email: 1, status: 1 } }).toArray()
      : Promise.resolve([]),
    pendingEmails.length
      ? mongoCollections.users.find({ email: { $in: pendingEmails }, deleted_at: null }, { projection: { email: 1 } }).toArray()
      : Promise.resolve([]),
  ]);
  const registeredEmailList = [...new Set([
    ...registeredPendingUsers.map((user) => user.email),
    ...registeredInvites.filter((invite) => invite.status === 'pending').map((invite) => invite.email),
  ].filter((email): email is string => !!email))];
  if (registeredEmailList.length) {
    await mongoCollections.admin_invites.updateMany(
      { status: 'pending', email: { $in: registeredEmailList } },
      { $set: { status: 'registered' } },
    );
  }
  const pendingInviteTotal = await mongoCollections.admin_invites.countDocuments(inviteFilter);
  const licenseByUser = new Map(licenseRows.map((license) => [license.user_id, {
    plan: license.plan,
    status: license.status,
    quotaRemaining: license.quota_remaining,
    quotaGranted: license.quota_granted,
  }]));
  const invitedAccountEmails = new Set(registeredInvites.map((invite) => invite.email));
  const existingEmails = new Set(registeredPendingUsers.map((user) => user.email));

  res.json({
    users: rows.map((user) => ({
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.first_name,
      lastName: user.last_name,
      company: user.company,
      emailVerified: !!user.email_verified,
      status: invitedAccountEmails.has(user.email ?? '') ? 'Registered' : user.email_verified ? 'Active' : 'Unverified',
      twoFactorEnabled: !!user.two_factor_enabled,
      hasUsedTrial: !!user.trial_started_at,
      createdAt: user.created_at,
      license: licenseByUser.get(user.id) ?? null,
    })),
    invitedUsers: pendingInviteRows
      .filter((invite) => !existingEmails.has(invite.email))
      .map((invite) => ({ id: invite.id, email: invite.email, invitedAt: invite.invited_at, status: 'Invited' })),
    totalInvites: pendingInviteTotal,
    page,
    pageSize,
    total,
  });
});

router.post('/invite', inviteLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Enter a valid email address' });
    return;
  }
  if (await mongoCollections.users.findOne({ email }, { projection: { id: 1 } })) {
    res.status(409).json({ error: 'An active account already uses this email' });
    return;
  }
  if (!config.brevo.apiKey && !config.smtp.host && !config.smtp.url) {
    res.status(503).json({ error: 'Email delivery is not configured on this relay' });
    return;
  }
  const inviter = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'FocusKube Admin';
  await sendAdminInviteEmail(email, inviter);
  await mongoCollections.admin_invites.updateOne(
    { email },
    { $set: { status: 'pending', invited_by: req.user?.id ?? 'admin', invited_at: new Date().toISOString() }, $setOnInsert: { id: crypto.randomUUID(), email } },
    { upsert: true },
  );
  res.json({ ok: true });
});
