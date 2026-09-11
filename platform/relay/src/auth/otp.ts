import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { randomOtpCode, sha256 } from './crypto.js';

const MAX_ATTEMPTS = 5;

function hashCode(destination: string, code: string): string {
  // Peppered so a DB dump alone isn't enough to brute-force a 6-digit code offline.
  return sha256(`${config.otpPepper}:${destination}:${code}`);
}

export function createOtp(destination: string, channel: 'email' | 'sms', purpose: string): string {
  const code = randomOtpCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otpTtlMinutes * 60 * 1000);

  // Only one code should ever be valid at a time for a given destination+purpose —
  // invalidate anything still pending before issuing the new one.
  db.prepare(
    `UPDATE otp_codes SET consumed_at = ? WHERE destination = ? AND purpose = ? AND consumed_at IS NULL`,
  ).run(now.toISOString(), destination, purpose);

  db.prepare(
    `INSERT INTO otp_codes (id, destination, channel, code_hash, purpose, attempts, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    destination,
    channel,
    hashCode(destination, code),
    purpose,
    now.toISOString(),
    expiresAt.toISOString(),
  );
  return code;
}

export function recentOtpCount(destination: string, purpose: string, sinceMs: number): number {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { c } = db
    .prepare(`SELECT COUNT(*) as c FROM otp_codes WHERE destination = ? AND purpose = ? AND created_at > ?`)
    .get(destination, purpose, since) as { c: number };
  return c;
}

export interface OtpVerifyResult {
  ok: boolean;
  error?: string;
}

export function verifyOtp(destination: string, purpose: string, code: string): OtpVerifyResult {
  const row = db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at FROM otp_codes
       WHERE destination = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(destination, purpose) as
    | { id: string; code_hash: string; attempts: number; expires_at: string }
    | undefined;

  if (!row) return { ok: false, error: 'No pending code for this destination — request a new one' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Code has expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts — request a new code' };

  if (hashCode(destination, code) !== row.code_hash) {
    db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
    return { ok: false, error: 'Incorrect code' };
  }

  db.prepare(`UPDATE otp_codes SET consumed_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
  return { ok: true };
}
