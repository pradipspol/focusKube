import crypto from 'node:crypto';
import type { Document } from 'mongodb';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { mongoCollections } from '../mongoCollections.js';
import { randomOtpCode, sha256 } from './crypto.js';

const MAX_ATTEMPTS = 5;

function hashCode(destination: string, code: string): string {
  // Peppered so a DB dump alone isn't enough to brute-force a 6-digit code offline.
  return sha256(`${config.otpPepper}:${destination}:${code}`);
}

export interface OtpRow extends Document {
  id: string;
  destination: string;
  channel: 'email' | 'sms';
  code_hash: string;
  purpose: string;
  attempts: number;
  consumed_at?: string | null;
  created_at: string;
  expires_at: string;
}

export async function createOtp(destination: string, channel: 'email' | 'sms', purpose: string): Promise<string> {
  const code = randomOtpCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otpTtlMinutes * 60 * 1000);

  // Only one code should ever be valid at a time for a given destination+purpose Ã¢â‚¬â€
  // invalidate anything still pending before issuing the new one.
  await withTransaction(async (session) => {
    const collection = mongoCollections.otp_codes;
    await collection.updateMany(
      { destination, purpose, consumed_at: null },
      { $set: { consumed_at: now.toISOString() } },
      { session },
    );
    await collection.insertOne({
      id: crypto.randomUUID(), destination, channel, code_hash: hashCode(destination, code), purpose,
      attempts: 0, consumed_at: null, created_at: now.toISOString(), expires_at: expiresAt.toISOString(),
    }, { session });
  });
  return code;
}

export async function recentOtpCount(destination: string, purpose: string, sinceMs: number): Promise<number> {
  const since = new Date(Date.now() - sinceMs).toISOString();
  return mongoCollections.otp_codes.countDocuments({ destination, purpose, created_at: { $gt: since } });
}

export interface OtpVerifyResult {
  ok: boolean;
  error?: string;
}

export async function verifyOtp(destination: string, purpose: string, code: string): Promise<OtpVerifyResult> {
  const collection = mongoCollections.otp_codes;
  const row = await collection.findOne({ destination, purpose, consumed_at: null }, { sort: { created_at: -1 } });

  if (!row) return { ok: false, error: 'No pending code for this destination Ã¢â‚¬â€ request a new one' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Code has expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts Ã¢â‚¬â€ request a new code' };

  if (hashCode(destination, code) !== row.code_hash) {
    await collection.updateOne({ id: row.id, consumed_at: null }, { $inc: { attempts: 1 } });
    return { ok: false, error: 'Incorrect code' };
  }

  const consumed = await collection.updateOne(
    { id: row.id, consumed_at: null, attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { consumed_at: new Date().toISOString() } },
  );
  return consumed.modifiedCount ? { ok: true } : { ok: false, error: 'Code has already been used' };
}
