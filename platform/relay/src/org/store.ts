import crypto from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { config } from '../config.js';
import type {
  LicensesMongoService,
  OrganizationInvitesMongoService,
  OrganizationMembersMongoService,
  OrganizationsMongoService,
  UsersMongoService,
} from '../mongoCollections.js';
import { logDebug, logInfo } from '../logger.js';
import { randomToken, sha256 } from '../auth/crypto.js';

export interface OrganizationRow {
  id: string;
  name: string;
  owner_user_id: string;
  status: 'pending' | 'active' | 'inactive' | 'cancelled';
  seats_purchased: number;
  created_at: string;
  updated_at: string;
  seat_claim_lock_id?: string;
  seat_claim_lock_until?: string;
}

export interface OrganizationMemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'member';
  status: 'active' | 'removed';
  license_key: string;
  calls_used: number;
  invited_by_user_id: string | null;
  joined_at: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInviteRow {
  id: string;
  org_id: string;
  email: string;
  token_hash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_by_user_id: string;
  accepted_user_id: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface OrganizationRepositories {
  organizations: Pick<OrganizationsMongoService, 'insertOne' | 'findOne' | 'findOneAndUpdate' | 'updateOne'>;
  members: Pick<OrganizationMembersMongoService, 'insertOne' | 'findOne' | 'updateOne' | 'countDocuments' | 'aggregate'>;
  invites: Pick<OrganizationInvitesMongoService, 'insertOne' | 'find' | 'findOne' | 'updateOne' | 'countDocuments'>;
  licenses: Pick<LicensesMongoService, 'findOne'>;
  users: Pick<UsersMongoService, 'updateOne'>;
}

export interface SeatCounts {
  purchased: number;
  filled: number;
  pending: number;
  available: number;
}

export interface MemberWithUser extends OrganizationMemberRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export class OrganizationService {
  constructor(private readonly repositories: OrganizationRepositories) {}

  private async withSeatClaimLock<T>(orgId: string, operation: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    const lockId = crypto.randomUUID();
    const now = new Date();
    const locked = await this.repositories.organizations.findOneAndUpdate(
      {
        id: orgId,
        $or: [
          { seat_claim_lock_until: { $lte: now.toISOString() } },
          { seat_claim_lock_until: { $exists: false } },
        ],
      },
      { $set: { seat_claim_lock_id: lockId, seat_claim_lock_until: new Date(now.getTime() + 60_000).toISOString() } },
      { returnDocument: 'after' },
    );
    if (!locked) return { acquired: false };
    try {
      return { acquired: true, result: await operation() };
    } finally {
      await this.repositories.organizations.updateOne(
        { id: orgId, seat_claim_lock_id: lockId },
        { $unset: { seat_claim_lock_id: '', seat_claim_lock_until: '' } },
      );
    }
  }

  async createPendingOrg(ownerUserId: string, name: string): Promise<OrganizationRow> {
    logDebug('Creating pending organization', { ownerUserId, nameLength: name.length });
    const now = new Date().toISOString();
    const org: OrganizationRow = {
      id: crypto.randomUUID(), name, owner_user_id: ownerUserId, status: 'pending',
      seats_purchased: 0, created_at: now, updated_at: now,
    };
    await this.repositories.organizations.insertOne(org);
    logInfo('Pending organization created', { orgId: org.id, ownerUserId });
    return org;
  }

  async findOrgById(id: string): Promise<OrganizationRow | undefined> {
    return (await this.repositories.organizations.findOne({ id })) ?? undefined;
  }

  async findOrgByOwner(ownerUserId: string): Promise<OrganizationRow | undefined> {
    return (await this.repositories.organizations.findOne({ owner_user_id: ownerUserId })) ?? undefined;
  }

  async findOrgBySubscriptionId(subscriptionId: string): Promise<OrganizationRow | undefined> {
    const license = await this.repositories.licenses.findOne({ stripe_subscription_id: subscriptionId, org_id: { $type: 'string' } });
    return typeof license?.org_id === 'string' ? this.findOrgById(license.org_id) : undefined;
  }

  async activateOrg(orgId: string, seats: number): Promise<void> {
    logDebug('Activating organization', { orgId, seats });
    await this.repositories.organizations.updateOne(
      { id: orgId }, { $set: { status: 'active', seats_purchased: seats, updated_at: new Date().toISOString() } },
    );
    logInfo('Organization activated', { orgId, seats });
  }

  async setOrgSeatsPurchased(orgId: string, seats: number): Promise<void> {
    logDebug('Updating purchased organization seats', { orgId, seats });
    await this.repositories.organizations.updateOne(
      { id: orgId }, { $set: { seats_purchased: seats, updated_at: new Date().toISOString() } },
    );
    logInfo('Purchased organization seats updated', { orgId, seats });
  }

  async setOrgStatus(orgId: string, status: OrganizationRow['status']): Promise<void> {
    logDebug('Updating organization status', { orgId, status });
    await this.repositories.organizations.updateOne(
      { id: orgId }, { $set: { status, updated_at: new Date().toISOString() } },
    );
    logInfo('Organization status updated', { orgId, status });
  }

  async renameOrg(orgId: string, name: string): Promise<void> {
    logDebug('Renaming organization', { orgId, nameLength: name.length });
    await this.repositories.organizations.updateOne(
      { id: orgId }, { $set: { name, updated_at: new Date().toISOString() } },
    );
    logInfo('Organization renamed', { orgId });
  }

  async seatCounts(orgId: string, session?: ClientSession): Promise<SeatCounts> {
    const [org, filled, pending] = await Promise.all([
      this.repositories.organizations.findOne({ id: orgId }, { session }),
      this.repositories.members.countDocuments(
        { org_id: orgId, status: 'active' }, { session },
      ),
      this.repositories.invites.countDocuments({
        org_id: orgId, status: 'pending', expires_at: { $gt: new Date().toISOString() },
      }, { session }),
    ]);
    const purchased = org?.seats_purchased ?? 0;
    return { purchased, filled, pending, available: Math.max(purchased - filled - pending, 0) };
  }

  async findActiveMembership(
    userId: string,
  ): Promise<(OrganizationMemberRow & { org_name: string; org_status: OrganizationRow['status'] }) | undefined> {
    const member = await this.repositories.members.findOne({ user_id: userId, status: 'active' });
    if (!member) return undefined;
    const org = await this.findOrgById(member.org_id);
    if (!org) return undefined;
    return { ...member, org_name: org.name, org_status: org.status };
  }

  async findMember(orgId: string, userId: string): Promise<OrganizationMemberRow | undefined> {
    return (await this.repositories.members.findOne({ org_id: orgId, user_id: userId })) ?? undefined;
  }

  async listActiveMembers(orgId: string): Promise<MemberWithUser[]> {
    return this.repositories.members.aggregate<MemberWithUser>([
      { $match: { org_id: orgId, status: 'active' } },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
      { $unwind: '$user' },
      { $sort: { joined_at: 1 } },
      { $project: {
        _id: 0, id: 1, org_id: 1, user_id: 1, role: 1, status: 1, license_key: 1,
        calls_used: 1, invited_by_user_id: 1, joined_at: 1, removed_at: 1, created_at: 1, updated_at: 1,
        email: '$user.email', first_name: '$user.first_name', last_name: '$user.last_name',
      } },
    ]).toArray();
  }

  async listPendingInvites(orgId: string): Promise<OrganizationInviteRow[]> {
    return this.repositories.invites.find({
      org_id: orgId, status: 'pending', expires_at: { $gt: new Date().toISOString() },
    }).sort({ created_at: 1 }).toArray();
  }

  async seatUser(
    orgId: string,
    userId: string,
    role: 'owner' | 'member',
    invitedByUserId: string | null,
    session?: ClientSession,
  ): Promise<string> {
    logDebug('Assigning organization seat', { orgId, userId, role });
    const key = `fk_seat_${crypto.randomBytes(24).toString('hex')}`;
    const now = new Date().toISOString();
    const members = this.repositories.members;
    const existing = await members.findOne({ org_id: orgId, user_id: userId }, { session });
    if (existing) {
      await members.updateOne({ id: existing.id }, { $set: {
        role, status: 'active', license_key: key, invited_by_user_id: invitedByUserId,
        joined_at: now, removed_at: null, updated_at: now,
      } }, { session });
    } else {
      await members.insertOne({
        id: crypto.randomUUID(), org_id: orgId, user_id: userId, role, status: 'active', license_key: key,
        calls_used: 0, invited_by_user_id: invitedByUserId, joined_at: now, removed_at: null,
        created_at: now, updated_at: now,
      }, { session });
    }
    logInfo('Organization seat assigned', { orgId, userId, role, reactivated: !!existing });
    return key;
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    logDebug('Removing organization member', { orgId, userId });
    const now = new Date().toISOString();
    await this.repositories.members.updateOne(
      { org_id: orgId, user_id: userId, status: 'active' }, { $set: { status: 'removed', removed_at: now, updated_at: now } },
    );
    logInfo('Organization member removed', { orgId, userId });
  }

  async regenerateMemberKey(memberId: string): Promise<string> {
    logDebug('Regenerating organization member credential', { memberId });
    const key = `fk_seat_${crypto.randomBytes(24).toString('hex')}`;
    await this.repositories.members.updateOne(
      { id: memberId }, { $set: { license_key: key, updated_at: new Date().toISOString() } },
    );
    logInfo('Organization member credential regenerated', { memberId });
    return key;
  }

  private async persistInvite(
    orgId: string,
    email: string,
    invitedByUserId: string,
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    logDebug('Creating organization invite', { orgId, invitedByUserId });
    const token = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.org.inviteTtlDays * 24 * 60 * 60 * 1000);
    const id = crypto.randomUUID();
    await this.repositories.invites.insertOne({
      id, org_id: orgId, email, token_hash: sha256(token), status: 'pending', invited_by_user_id: invitedByUserId,
      accepted_user_id: null, created_at: now.toISOString(), expires_at: expiresAt.toISOString(),
      accepted_at: null, revoked_at: null,
    });
    logInfo('Organization invite created', { orgId, inviteId: id, invitedByUserId });
    return { id, token, expiresAt: expiresAt.toISOString() };
  }

  async createInviteWithAvailableSeat(
    orgId: string,
    email: string,
    invitedByUserId: string,
  ): Promise<{ invite: { id: string; token: string; expiresAt: string } } | { error: string }> {
    const claim = await this.withSeatClaimLock(orgId, async () => {
      const org = await this.findOrgById(orgId);
      if (!org || org.status !== 'active') return { error: 'Your team subscription is not active' };
      const counts = await this.seatCounts(orgId);
      if (counts.filled + counts.pending >= counts.purchased) {
        return { error: `All ${counts.purchased} seats are assigned or reserved by pending invites. Add a seat or cancel an invitation first.` };
      }
      if (await this.findPendingInviteForEmail(orgId, email)) {
        return { error: 'Already invited — use Resend instead' };
      }
      return { invite: await this.persistInvite(orgId, email, invitedByUserId) };
    });
    return claim.acquired
      ? claim.result!
      : { error: 'Team seats are being updated. Please try again shortly.' };
  }

  async findInviteByToken(token: string): Promise<OrganizationInviteRow | undefined> {
    const invites = this.repositories.invites;
    const tokenHash = sha256(token);
    const now = new Date().toISOString();
    await invites.updateOne(
      { token_hash: tokenHash, status: 'pending', expires_at: { $lte: now } }, { $set: { status: 'expired' } },
    );
    return (await invites.findOne({ token_hash: tokenHash })) ?? undefined;
  }

  async findPendingInviteForEmail(orgId: string, email: string): Promise<OrganizationInviteRow | undefined> {
    return (await this.repositories.invites.findOne({ org_id: orgId, email, status: 'pending' })) ?? undefined;
  }

  async revokeInvite(orgId: string, id: string): Promise<'revoked' | 'not-found' | 'busy'> {
    logDebug('Revoking organization invite', { inviteId: id });
    const claim = await this.withSeatClaimLock(orgId, async () => {
      const result = await this.repositories.invites.updateOne(
        { id, org_id: orgId, status: 'pending' },
        { $set: { status: 'revoked', revoked_at: new Date().toISOString() } },
      );
      return result.modifiedCount ? 'revoked' as const : 'not-found' as const;
    });
    if (!claim.acquired) return 'busy';
    if (claim.result === 'revoked') logInfo('Organization invite revocation completed', { inviteId: id });
    return claim.result!;
  }

  async resendInvite(orgId: string, id: string): Promise<{ token: string; expiresAt: string } | undefined> {
    logDebug('Rotating organization invite credential', { inviteId: id });
    const token = randomToken();
    const expiresAt = new Date(Date.now() + config.org.inviteTtlDays * 24 * 60 * 60 * 1000).toISOString();
    await this.repositories.invites.updateOne(
      { id, org_id: orgId, status: 'pending' }, { $set: { token_hash: sha256(token), expires_at: expiresAt } },
    );
    logInfo('Organization invite credential rotated', { inviteId: id });
    return { token, expiresAt };
  }

  async markInviteAccepted(id: string, userId: string, session?: ClientSession): Promise<void> {
    logDebug('Accepting organization invite', { inviteId: id, userId });
    await this.repositories.invites.updateOne(
      { id, status: 'pending' }, { $set: { status: 'accepted', accepted_user_id: userId, accepted_at: new Date().toISOString() } },
      { session },
    );
    logInfo('Organization invite accepted', { inviteId: id, userId });
  }

  async claimInviteSeat(
    invite: Pick<OrganizationInviteRow, 'id' | 'invited_by_user_id'>,
    orgId: string,
    userId: string,
    emailVerified: boolean,
  ): Promise<string | undefined> {
    const claim = await this.withSeatClaimLock(orgId, async () => {
      const org = await this.findOrgById(orgId);
      if (!org || org.status !== 'active') return 'This team is not currently active';
      const freshInvite = await this.repositories.invites.findOne(
        { id: invite.id, status: 'pending', expires_at: { $gt: new Date().toISOString() } },
      );
      if (!freshInvite) return 'This invite is invalid or has expired';

      const existingMember = await this.repositories.members.findOne({ org_id: orgId, user_id: userId });
      if (existingMember?.status !== 'active') {
        const counts = await this.seatCounts(orgId);
        if (counts.filled >= counts.purchased) return `All ${counts.purchased} seats are taken`;
        await this.seatUser(orgId, userId, 'member', invite.invited_by_user_id);
      }
      if (!emailVerified) {
        await this.repositories.users.updateOne(
          { id: userId }, { $set: { email_verified: 1, updated_at: new Date().toISOString() } },
        );
      }
      const accepted = await this.repositories.invites.updateOne(
        { id: invite.id, status: 'pending' },
        { $set: { status: 'accepted', accepted_user_id: userId, accepted_at: new Date().toISOString() } },
      );
      if (!accepted.modifiedCount) throw new Error('Invite was already accepted');
      return undefined;
    });
    return claim.acquired ? claim.result : 'A team seat is being assigned. Please try again shortly.';
  }

  async claimOwnerSeat(orgId: string, userId: string): Promise<string | undefined> {
    const claim = await this.withSeatClaimLock(orgId, async () => {
      const org = await this.findOrgById(orgId);
      if (!org || org.status !== 'active') return 'Your team subscription is not active';
      const existing = await this.repositories.members.findOne({ org_id: orgId, user_id: userId });
      if (existing?.status === 'active') return 'You are already using a team seat';
      const counts = await this.seatCounts(orgId);
      if (counts.available < 1) return 'No team seats are available. Add a seat or remove a member first.';
      await this.seatUser(orgId, userId, 'owner', null);
      return undefined;
    });
    return claim.acquired ? claim.result : 'A team seat is being assigned. Please try again shortly.';
  }

  async countInvitesSince(orgId: string, sinceIso: string): Promise<number> {
    return this.repositories.invites.countDocuments({ org_id: orgId, created_at: { $gt: sinceIso } });
  }

  async hasActiveSeatElsewhere(userId: string, excludeOrgId: string): Promise<boolean> {
    return !!(await this.repositories.members.findOne({
      user_id: userId, org_id: { $ne: excludeOrgId }, status: 'active',
    }));
  }
}
