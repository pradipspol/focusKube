import crypto from 'node:crypto';

/** Shared opaque-token helpers for sessions, OTP codes, and password-reset tokens —
 * all three follow the same "random token, hash it, look up by hash" shape. */

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}
