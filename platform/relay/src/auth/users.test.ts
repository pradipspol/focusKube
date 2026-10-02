import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpdateFilter } from 'mongodb';
import { UserService, type UserRepository, type UserRow } from './users.js';

function createInMemoryRepository(): UserRepository {
  let user: UserRow | null = null;
  return {
    async findOne(filter) {
      if (!user) return null;
      return Object.entries(filter).every(([key, value]) => user?.[key as keyof UserRow] === value) ? user : null;
    },
    async insertOne(document) {
      user = document;
    },
    async updateOne(filter, update) {
      if (!user || !Object.entries(filter).every(([key, value]) => user?.[key as keyof UserRow] === value)) return;
      const set = (update as UpdateFilter<UserRow>).$set;
      if (set) user = { ...user, ...set };
    },
  };
}

test('UserService creates normalized users through an injected repository', async () => {
  const service = new UserService(createInMemoryRepository());
  const user = await service.createUser({ email: 'ALICE@example.com', first_name: 'Alice' });

  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.first_name, 'Alice');
  assert.equal(user.product_updates_opt_in, 1);
  assert.equal((await service.findUserByEmail('ALICE@example.com'))?.id, user.id);
});

test('UserService profile updates only change supplied fields', async () => {
  const service = new UserService(createInMemoryRepository());
  const user = await service.createUser({ email: 'alice@example.com', first_name: 'Alice', last_name: 'Smith' });

  await service.updateProfile(user.id, { firstName: 'Alicia' });
  const updated = await service.findUserById(user.id);

  assert.equal(updated?.first_name, 'Alicia');
  assert.equal(updated?.last_name, 'Smith');
});
