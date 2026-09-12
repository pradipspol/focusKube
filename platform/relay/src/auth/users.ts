import crypto from 'node:crypto';
import { db } from '../db.js';

export interface UserRow {
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

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as UserRow | undefined;
}

export function findUserByPhone(phone: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone) as UserRow | undefined;
}

export function findUserByGoogleSub(sub: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE google_sub = ?`).get(sub) as UserRow | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function createUser(fields: Partial<UserRow>): UserRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, phone, password_hash, google_sub, email_verified, phone_verified, first_name, last_name, created_at, updated_at)
     VALUES (@id, @email, @phone, @password_hash, @google_sub, @email_verified, @phone_verified, @first_name, @last_name, @created_at, @updated_at)`,
  ).run({
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
  });
  return findUserById(id)!;
}

export function markEmailVerified(userId: string): void {
  db.prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), userId);
}

export function markPhoneVerified(userId: string): void {
  db.prepare(`UPDATE users SET phone_verified = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), userId);
}

export function setEmail(userId: string, email: string, verified: boolean): void {
  db.prepare(`UPDATE users SET email = ?, email_verified = ?, updated_at = ? WHERE id = ?`).run(
    email.toLowerCase(),
    verified ? 1 : 0,
    new Date().toISOString(),
    userId,
  );
}

export function setPassword(userId: string, passwordHash: string): void {
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(
    passwordHash,
    new Date().toISOString(),
    userId,
  );
}

export function linkGoogleSub(userId: string, googleSub: string): void {
  db.prepare(`UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?`).run(
    googleSub,
    new Date().toISOString(),
    userId,
  );
}

export function markTrialStarted(userId: string): void {
  db.prepare(`UPDATE users SET trial_started_at = ?, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    new Date().toISOString(),
    userId,
  );
}

export interface ProfileUpdate {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  avatarDataUrl?: string | null;
  productUpdatesOptIn?: boolean;
}

/** Partial update — a field left out of `fields` keeps its current value. Used by the
 * profile page (name/company/avatar/comm-preferences), which saves all of these at once. */
export function updateProfile(userId: string, fields: ProfileUpdate): void {
  const current = findUserById(userId);
  if (!current) return;
  db.prepare(
    `UPDATE users SET first_name = ?, last_name = ?, company = ?, avatar_data_url = ?, product_updates_opt_in = ?, updated_at = ? WHERE id = ?`,
  ).run(
    fields.firstName !== undefined ? fields.firstName : current.first_name,
    fields.lastName !== undefined ? fields.lastName : current.last_name,
    fields.company !== undefined ? fields.company : current.company,
    fields.avatarDataUrl !== undefined ? fields.avatarDataUrl : current.avatar_data_url,
    fields.productUpdatesOptIn !== undefined ? (fields.productUpdatesOptIn ? 1 : 0) : current.product_updates_opt_in,
    new Date().toISOString(),
    userId,
  );
}

export function setTwoFactorEnabled(userId: string, enabled: boolean): void {
  db.prepare(`UPDATE users SET two_factor_enabled = ?, updated_at = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    new Date().toISOString(),
    userId,
  );
}

/** Soft delete: marks the row deleted (kept for a possible recovery window) rather than
 * erasing it. Login paths and userFromSessionToken all reject a deleted_at account, and
 * account/routes.ts's /delete handler revokes the license and every session up front. */
export function softDeleteUser(userId: string): void {
  db.prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    new Date().toISOString(),
    userId,
  );
}
