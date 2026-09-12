/**
 * DB access for Team (multi-seat) licensing: organizations, organization_members,
 * organization_invites (see db.ts for the schema and the reasoning behind it). Mirrors the
 * role licenseStore.ts plays for personal licenses — org/billing.ts and org/routes.ts build
 * on these, not on raw SQL of their own.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { randomToken, sha256 } from '../auth/crypto.js';

export interface OrganizationRow {
  id: string;
  name: string;
  owner_user_id: string;
  status: 'pending' | 'active' | 'inactive' | 'cancelled';
  seats_purchased: number;
  created_at: string;
  updated_at: string;
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

export function createPendingOrg(ownerUserId: string, name: string): OrganizationRow {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO organizations (id, name, owner_user_id, status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(id, name, ownerUserId, now, now);
  return findOrgById(id)!;
}

export function findOrgById(id: string): OrganizationRow | undefined {
  return db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(id) as OrganizationRow | undefined;
}

export function findOrgByOwner(ownerUserId: string): OrganizationRow | undefined {
  return db.prepare(`SELECT * FROM organizations WHERE owner_user_id = ?`).get(ownerUserId) as
    | OrganizationRow
    | undefined;
}

/** Looks up an org by its pooled license's Stripe subscription id — the webhook's only way
 * to find "which org does this subscription event belong to" (see billing/routes.ts). */
export function findOrgBySubscriptionId(subscriptionId: string): OrganizationRow | undefined {
  return db
    .prepare(
      `SELECT o.* FROM organizations o JOIN licenses l ON l.org_id = o.id WHERE l.stripe_subscription_id = ?`,
    )
    .get(subscriptionId) as OrganizationRow | undefined;
}

export function activateOrg(orgId: string, seats: number): void {
  db.prepare(`UPDATE organizations SET status = 'active', seats_purchased = ?, updated_at = ? WHERE id = ?`).run(
    seats,
    new Date().toISOString(),
    orgId,
  );
}

export function setOrgSeatsPurchased(orgId: string, seats: number): void {
  db.prepare(`UPDATE organizations SET seats_purchased = ?, updated_at = ? WHERE id = ?`).run(
    seats,
    new Date().toISOString(),
    orgId,
  );
}

export function setOrgStatus(orgId: string, status: OrganizationRow['status']): void {
  db.prepare(`UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    orgId,
  );
}

export function renameOrg(orgId: string, name: string): void {
  db.prepare(`UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?`).run(name, new Date().toISOString(), orgId);
}

export interface SeatCounts {
  purchased: number;
  filled: number;
  pending: number;
  available: number;
}

export function seatCounts(orgId: string): SeatCounts {
  const org = findOrgById(orgId);
  const purchased = org?.seats_purchased ?? 0;
  const { filled } = db
    .prepare(`SELECT COUNT(*) AS filled FROM organization_members WHERE org_id = ? AND status = 'active'`)
    .get(orgId) as { filled: number };
  const { pending } = db
    .prepare(
      `SELECT COUNT(*) AS pending FROM organization_invites
        WHERE org_id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .get(orgId, new Date().toISOString()) as { pending: number };
  return { purchased, filled, pending, available: Math.max(purchased - filled - pending, 0) };
}

/** A user's active seat, if any, joined with their org's name/status — the one query
 * org/entitlement.ts needs to know "is this user covered by a Team plan right now." */
export function findActiveMembership(
  userId: string,
): (OrganizationMemberRow & { org_name: string; org_status: OrganizationRow['status'] }) | undefined {
  return db
    .prepare(
      `SELECT m.*, o.name AS org_name, o.status AS org_status
         FROM organization_members m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ? AND m.status = 'active'`,
    )
    .get(userId) as (OrganizationMemberRow & { org_name: string; org_status: OrganizationRow['status'] }) | undefined;
}

export function findMember(orgId: string, userId: string): OrganizationMemberRow | undefined {
  return db.prepare(`SELECT * FROM organization_members WHERE org_id = ? AND user_id = ?`).get(orgId, userId) as
    | OrganizationMemberRow
    | undefined;
}

export interface MemberWithUser extends OrganizationMemberRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export function listActiveMembers(orgId: string): MemberWithUser[] {
  return db
    .prepare(
      `SELECT m.*, u.email, u.first_name, u.last_name
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.status = 'active'
        ORDER BY m.joined_at ASC`,
    )
    .all(orgId) as MemberWithUser[];
}

export function listPendingInvites(orgId: string): OrganizationInviteRow[] {
  return db
    .prepare(
      `SELECT * FROM organization_invites WHERE org_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC`,
    )
    .all(orgId, new Date().toISOString()) as OrganizationInviteRow[];
}

/** Inserts a fresh seat, or reactivates a previously-removed one for the same org+user
 * (rather than inserting a duplicate row, which the org_id+user_id unique index forbids).
 * Always issues a brand-new license_key — a rejoining member never gets their old key back. */
export function seatUser(
  orgId: string,
  userId: string,
  role: 'owner' | 'member',
  invitedByUserId: string | null,
): string {
  const key = `fk_seat_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?`).get(orgId, userId) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE organization_members
          SET role = ?, status = 'active', license_key = ?, invited_by_user_id = ?,
              joined_at = ?, removed_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(role, key, invitedByUserId, now, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO organization_members
         (id, org_id, user_id, role, status, license_key, calls_used, invited_by_user_id, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), orgId, userId, role, key, invitedByUserId, now, now, now);
  }
  return key;
}

/** Marks a seat removed without clearing license_key — the dead key stays permanently
 * reserved (license_key is UNIQUE NOT NULL) so it can never be reissued, and
 * licenseStore.ts's lookupLicense already filters on status='active', so the key stops
 * working on its very next use with no rotation of anyone else's key. */
export function removeMember(orgId: string, userId: string): void {
  db.prepare(
    `UPDATE organization_members SET status = 'removed', removed_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ?`,
  ).run(new Date().toISOString(), new Date().toISOString(), orgId, userId);
}

export function regenerateMemberKey(memberId: string): string {
  const key = `fk_seat_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare(`UPDATE organization_members SET license_key = ?, updated_at = ? WHERE id = ?`).run(
    key,
    new Date().toISOString(),
    memberId,
  );
  return key;
}

export function createInvite(
  orgId: string,
  email: string,
  invitedByUserId: string,
): { id: string; token: string; expiresAt: string } {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.org.inviteTtlDays * 24 * 60 * 60 * 1000);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO organization_invites (id, org_id, email, token_hash, status, invited_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, orgId, email, sha256(token), invitedByUserId, now.toISOString(), expiresAt.toISOString());
  return { id, token, expiresAt: expiresAt.toISOString() };
}

/** Lazily expires a pending invite past its deadline, same shape as licenseStore.ts's
 * expireIfPastDeadline — there's no job scheduler in this service. */
function expireInviteIfPastDeadline(id: string): void {
  db.prepare(
    `UPDATE organization_invites SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at < ?`,
  ).run(id, new Date().toISOString());
}

export function findInviteByToken(token: string): OrganizationInviteRow | undefined {
  const row = db.prepare(`SELECT * FROM organization_invites WHERE token_hash = ?`).get(sha256(token)) as
    | OrganizationInviteRow
    | undefined;
  if (!row) return undefined;
  expireInviteIfPastDeadline(row.id);
  return db.prepare(`SELECT * FROM organization_invites WHERE id = ?`).get(row.id) as OrganizationInviteRow;
}

export function findPendingInviteForEmail(orgId: string, email: string): OrganizationInviteRow | undefined {
  return db
    .prepare(`SELECT * FROM organization_invites WHERE org_id = ? AND email = ? AND status = 'pending'`)
    .get(orgId, email) as OrganizationInviteRow | undefined;
}

export function revokeInvite(id: string): void {
  db.prepare(`UPDATE organization_invites SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'pending'`).run(
    new Date().toISOString(),
    id,
  );
}

/** Rotates an existing pending invite's token in place (resend) rather than creating a
 * second row — the pending-per-(org,email) unique index would reject a second insert anyway. */
export function resendInvite(id: string): { token: string; expiresAt: string } {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.org.inviteTtlDays * 24 * 60 * 60 * 1000);
  db.prepare(`UPDATE organization_invites SET token_hash = ?, expires_at = ? WHERE id = ?`).run(
    sha256(token),
    expiresAt.toISOString(),
    id,
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export function markInviteAccepted(id: string, userId: string): void {
  db.prepare(
    `UPDATE organization_invites SET status = 'accepted', accepted_user_id = ?, accepted_at = ? WHERE id = ?`,
  ).run(userId, new Date().toISOString(), id);
}

export function countInvitesSince(orgId: string, sinceIso: string): number {
  const { c } = db
    .prepare(`SELECT COUNT(*) AS c FROM organization_invites WHERE org_id = ? AND created_at > ?`)
    .get(orgId, sinceIso) as { c: number };
  return c;
}

/** True if `userId` currently holds an active seat in some org OTHER than `excludeOrgId`. */
export function hasActiveSeatElsewhere(userId: string, excludeOrgId: string): boolean {
  const membership = findActiveMembership(userId);
  return !!membership && membership.org_id !== excludeOrgId;
}
