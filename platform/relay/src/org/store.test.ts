import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientSession } from 'mongodb';
import { sha256 } from '../auth/crypto.js';
import {
  OrganizationService,
  type OrganizationInviteRow,
  type OrganizationMemberRow,
  type OrganizationRepositories,
  type OrganizationRow,
} from './store.js';

test('OrganizationService persists hashed invite credentials through an injected repository', async () => {
  const invites: OrganizationInviteRow[] = [];
  const service = new OrganizationService({
    organizations: {} as OrganizationRepositories['organizations'],
    members: {} as OrganizationRepositories['members'],
    invites: {
      async insertOne(invite: OrganizationInviteRow) {
        invites.push(invite);
      },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {} as OrganizationRepositories['users'],
  });

  const created = await service.createInvite('org-1', 'alice@example.com', 'user-1');
  const persisted = invites[0];

  assert.ok(persisted);
  assert.equal(persisted.id, created.id);
  assert.equal(persisted.org_id, 'org-1');
  assert.equal(persisted.email, 'alice@example.com');
  assert.equal(persisted.token_hash, sha256(created.token));
  assert.notEqual(persisted.token_hash, created.token);
  assert.equal(persisted.status, 'pending');
  assert.equal(persisted.invited_by_user_id, 'user-1');
});

test('OrganizationService accepts an invite and forwards the transaction session to every write', async () => {
  const session = {} as ClientSession;
  const organization: OrganizationRow = {
    id: 'org-1', name: 'Team', owner_user_id: 'owner-1', status: 'active', seats_purchased: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const invite: OrganizationInviteRow = {
    id: 'invite-1', org_id: organization.id, email: 'alice@example.com', token_hash: 'hash', status: 'pending',
    invited_by_user_id: 'owner-1', accepted_user_id: null, created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z', accepted_at: null, revoked_at: null,
  };
  const insertedMembers: OrganizationMemberRow[] = [];
  const forwardedSessions: unknown[] = [];
  type SessionOptions = { session?: ClientSession };
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async updateOne(_filter: Filter, _update: Update, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
      async findOne(_filter: Filter, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return organization;
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {
      async countDocuments(_filter: Filter, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return 0;
      },
      async findOne(_filter: Filter, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return null;
      },
      async insertOne(member: OrganizationMemberRow, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        insertedMembers.push(member);
      },
    } as unknown as OrganizationRepositories['members'],
    invites: {
      async countDocuments(_filter: Filter, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return 0;
      },
      async findOne(_filter: Filter, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return invite;
      },
      async updateOne(_filter: Filter, _update: Update, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {
      async updateOne(_filter: Filter, _update: Update, options?: SessionOptions) {
        forwardedSessions.push(options?.session);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['users'],
  });

  const rejected = await service.claimInviteSeat(invite, organization.id, 'alice-1', false, session);

  assert.equal(rejected, undefined);
  assert.equal(insertedMembers.length, 1);
  assert.equal(insertedMembers[0].user_id, 'alice-1');
  assert.ok(forwardedSessions.length > 0);
  assert.ok(forwardedSessions.every((forwarded) => forwarded === session));
});