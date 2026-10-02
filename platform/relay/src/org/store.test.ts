import assert from 'node:assert/strict';
import test from 'node:test';
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
  const organization: OrganizationRow = {
    id: 'org-1', name: 'Team', owner_user_id: 'owner-1', status: 'active', seats_purchased: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async findOneAndUpdate() { return organization; },
      async findOne() { return organization; },
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {
      async findOne() { return null; },
      async countDocuments() { return 0; },
    } as unknown as OrganizationRepositories['members'],
    invites: {
      async insertOne(invite: OrganizationInviteRow) {
        invites.push(invite);
      },
      async findOne() { return null; },
      async countDocuments() { return 0; },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {} as OrganizationRepositories['users'],
  });

  const result = await service.createInviteWithAvailableSeat('org-1', 'alice@example.com', 'user-1');
  assert.ok('invite' in result);
  const created = result.invite;
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

test('OrganizationService accepts an invite with serialized writes and no Mongo transaction', async () => {
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
  const acceptedInvites: string[] = [];
  type FindOptions = { returnDocument?: 'before' | 'after' };
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async findOneAndUpdate(_filter: Filter, _update: Update, _options?: FindOptions) {
        return organization;
      },
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
      async findOne(_filter: Filter) {
        return organization;
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {
      async countDocuments(_filter: Filter) {
        return 0;
      },
      async findOne(_filter: Filter) {
        return null;
      },
      async insertOne(member: OrganizationMemberRow) {
        insertedMembers.push(member);
      },
    } as unknown as OrganizationRepositories['members'],
    invites: {
      async countDocuments(_filter: Filter) {
        return 0;
      },
      async findOne(_filter: Filter) {
        return invite;
      },
      async updateOne(_filter: Filter) {
        acceptedInvites.push(invite.id);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['users'],
  });

  const rejected = await service.claimInviteSeat(invite, organization.id, 'alice-1', false);

  assert.equal(rejected, undefined);
  assert.equal(insertedMembers.length, 1);
  assert.equal(insertedMembers[0].user_id, 'alice-1');
  assert.equal(insertedMembers[0].status, 'active');
  assert.deepEqual(acceptedInvites, [invite.id]);
});

test('OrganizationService lets an owner claim an available team seat', async () => {
  const organization: OrganizationRow = {
    id: 'org-1', name: 'Team', owner_user_id: 'owner-1', status: 'active', seats_purchased: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const insertedMembers: OrganizationMemberRow[] = [];
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async findOneAndUpdate() { return organization; },
      async findOne() { return organization; },
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {
      async findOne() { return null; },
      async countDocuments() { return 0; },
      async insertOne(member: OrganizationMemberRow) { insertedMembers.push(member); },
    } as unknown as OrganizationRepositories['members'],
    invites: {
      async countDocuments() { return 0; },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {} as OrganizationRepositories['users'],
  });

  const error = await service.claimOwnerSeat(organization.id, organization.owner_user_id);

  assert.equal(error, undefined);
  assert.equal(insertedMembers.length, 1);
  assert.equal(insertedMembers[0].role, 'owner');
  assert.equal(insertedMembers[0].status, 'active');
});

test('OrganizationService rejects invitations when active members and pending invites fill all seats', async () => {
  const organization: OrganizationRow = {
    id: 'org-1', name: 'Team', owner_user_id: 'owner-1', status: 'active', seats_purchased: 2,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async findOneAndUpdate() { return organization; },
      async findOne() { return organization; },
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {
      async countDocuments() { return 1; },
    } as unknown as OrganizationRepositories['members'],
    invites: {
      async countDocuments() { return 1; },
      async findOne() { return null; },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {} as OrganizationRepositories['users'],
  });

  const result = await service.createInviteWithAvailableSeat(organization.id, 'alice@example.com', 'owner-1');

  assert.ok('error' in result);
  assert.match(result.error, /All 2 seats are assigned or reserved/);
});

test('OrganizationService scopes pending invite cancellation to the requested team', async () => {
  const organization: OrganizationRow = {
    id: 'org-1', name: 'Team', owner_user_id: 'owner-1', status: 'active', seats_purchased: 2,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  let cancellationFilter: Record<string, unknown> | undefined;
  type Filter = Record<string, unknown>;
  type Update = Record<string, unknown>;
  const service = new OrganizationService({
    organizations: {
      async findOneAndUpdate() { return organization; },
      async updateOne(_filter: Filter, _update: Update) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['organizations'],
    members: {} as OrganizationRepositories['members'],
    invites: {
      async updateOne(filter: Filter) {
        cancellationFilter = filter;
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      },
    } as unknown as OrganizationRepositories['invites'],
    licenses: {} as OrganizationRepositories['licenses'],
    users: {} as OrganizationRepositories['users'],
  });

  const result = await service.revokeInvite('org-1', 'invite-1');

  assert.equal(result, 'revoked');
  assert.deepEqual(cancellationFilter, { id: 'invite-1', org_id: 'org-1', status: 'pending' });
});