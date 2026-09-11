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
    `INSERT INTO users (id, email, phone, password_hash, google_sub, email_verified, phone_verified, created_at, updated_at)
     VALUES (@id, @email, @phone, @password_hash, @google_sub, @email_verified, @phone_verified, @created_at, @updated_at)`,
  ).run({
    id,
    email: fields.email?.toLowerCase() ?? null,
    phone: fields.phone ?? null,
    password_hash: fields.password_hash ?? null,
    google_sub: fields.google_sub ?? null,
    email_verified: fields.email_verified ?? 0,
    phone_verified: fields.phone_verified ?? 0,
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
