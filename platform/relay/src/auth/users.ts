import crypto from 'node:crypto';
import type { Document, Filter, UpdateFilter } from 'mongodb';
import { logDebug, logInfo } from '../logger.js';

export interface UserRow extends Document {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  google_sub: string | null;
  email_verified: number;
  phone_verified: number;
  display_name: string | null;
  trial_started_at: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  avatar_data_url: string | null;
  product_updates_opt_in: number;
  two_factor_enabled: number;
  deleted_at: string | null;
}

export interface ProfileUpdate {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  avatarDataUrl?: string | null;
  productUpdatesOptIn?: boolean;
}

export interface UserRepository {
  findOne(filter: Filter<UserRow>): Promise<UserRow | null>;
  insertOne(user: UserRow): Promise<unknown>;
  updateOne(filter: Filter<UserRow>, update: UpdateFilter<UserRow>): Promise<unknown>;
}

export class UserService {
  constructor(private readonly users: UserRepository) {}

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    return (await this.users.findOne({ email: email.toLowerCase() })) ?? undefined;
  }

  async findUserByPhone(phone: string): Promise<UserRow | undefined> {
    return (await this.users.findOne({ phone })) ?? undefined;
  }

  async findUserByGoogleSub(sub: string): Promise<UserRow | undefined> {
    return (await this.users.findOne({ google_sub: sub })) ?? undefined;
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    return (await this.users.findOne({ id })) ?? undefined;
  }

  async createUser(fields: Partial<UserRow>): Promise<UserRow> {
    logDebug('Creating user account', { hasEmail: !!fields.email, hasPhone: !!fields.phone });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const user: UserRow = {
      id,
      email: fields.email?.toLowerCase() ?? null,
      phone: fields.phone ?? null,
      password_hash: fields.password_hash ?? null,
      google_sub: fields.google_sub ?? null,
      email_verified: fields.email_verified ?? 0,
      phone_verified: fields.phone_verified ?? 0,
      first_name: fields.first_name ?? null,
      last_name: fields.last_name ?? null,
      created_at: now,
      updated_at: now,
      display_name: null,
      trial_started_at: null,
      company: null,
      avatar_data_url: null,
      product_updates_opt_in: 1,
      two_factor_enabled: 0,
      deleted_at: null,
    };
    await this.users.insertOne(user);
    logInfo('User account created', { userId: id });
    return user;
  }

  async markEmailVerified(userId: string): Promise<void> {
    logDebug('Marking user email as verified', { userId });
    await this.users.updateOne({ id: userId }, { $set: { email_verified: 1, updated_at: new Date().toISOString() } });
    logInfo('User email marked as verified', { userId });
  }

  async markPhoneVerified(userId: string): Promise<void> {
    logDebug('Marking user phone as verified', { userId });
    await this.users.updateOne({ id: userId }, { $set: { phone_verified: 1, updated_at: new Date().toISOString() } });
    logInfo('User phone marked as verified', { userId });
  }

  async setEmail(userId: string, email: string, verified: boolean): Promise<void> {
    logDebug('Updating user email address', { userId, verified });
    await this.users.updateOne({ id: userId }, { $set: {
      email: email.toLowerCase(),
      email_verified: verified ? 1 : 0,
      updated_at: new Date().toISOString(),
    } });
    logInfo('User email address updated', { userId, verified });
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    logDebug('Updating user password credential', { userId });
    await this.users.updateOne({ id: userId }, { $set: { password_hash: passwordHash, updated_at: new Date().toISOString() } });
    logInfo('User password credential updated', { userId });
  }

  async linkGoogleSub(userId: string, googleSub: string): Promise<void> {
    logDebug('Linking Google identity to user account', { userId });
    await this.users.updateOne({ id: userId }, { $set: { google_sub: googleSub, updated_at: new Date().toISOString() } });
    logInfo('Google identity linked to user account', { userId });
  }

  async markTrialStarted(userId: string): Promise<void> {
    logDebug('Recording user trial start', { userId });
    const now = new Date().toISOString();
    await this.users.updateOne({ id: userId }, { $set: { trial_started_at: now, updated_at: now } });
    logInfo('User trial start recorded', { userId });
  }

  /** Fields omitted from `fields` retain their current values. */
  async updateProfile(userId: string, fields: ProfileUpdate): Promise<void> {
    logDebug('Updating user profile', { userId, fields: Object.keys(fields) });
    const current = await this.findUserById(userId);
    if (!current) {
      logInfo('User profile update skipped because the account does not exist', { userId });
      return;
    }
    const update: Partial<UserRow> = { updated_at: new Date().toISOString() };
    if (fields.firstName !== undefined) update.first_name = fields.firstName;
    if (fields.lastName !== undefined) update.last_name = fields.lastName;
    if (fields.company !== undefined) update.company = fields.company;
    if (fields.avatarDataUrl !== undefined) update.avatar_data_url = fields.avatarDataUrl;
    if (fields.productUpdatesOptIn !== undefined) update.product_updates_opt_in = fields.productUpdatesOptIn ? 1 : 0;
    await this.users.updateOne({ id: userId }, { $set: update });
    logInfo('User profile updated', { userId, fields: Object.keys(fields) });
  }

  async setTwoFactorEnabled(userId: string, enabled: boolean): Promise<void> {
    logDebug('Updating user two-factor authentication setting', { userId, enabled });
    await this.users.updateOne({ id: userId }, { $set: { two_factor_enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() } });
    logInfo('User two-factor authentication setting updated', { userId, enabled });
  }

  /** Soft delete retains the user row for a possible recovery window. */
  async softDeleteUser(userId: string): Promise<void> {
    logDebug('Soft-deleting user account', { userId });
    const now = new Date().toISOString();
    await this.users.updateOne({ id: userId }, { $set: { deleted_at: now, updated_at: now } });
    logInfo('User account soft-deleted', { userId });
  }
}
