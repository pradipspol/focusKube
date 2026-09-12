import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { randomToken, sha256 } from './crypto.js';

export interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  avatarDataUrl: string | null;
  productUpdatesOptIn: boolean;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  hasGoogle: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

interface SessionRow {
  user_id: string;
  expires_at: string;
}

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  email_verified: number;
  phone_verified: number;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  avatar_data_url: string | null;
  product_updates_opt_in: number;
  two_factor_enabled: number;
  password_hash: string | null;
  google_sub: string | null;
  deleted_at: string | null;
}

/** Issues a new opaque session token (hashed at rest) and returns the plaintext for the cookie. */
export function createSession(userId: string): string {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(sha256(token), userId, now.toISOString(), expiresAt.toISOString(), now.toISOString());
  return token;
}

export function revokeSession(token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
}

/** Signs an account out everywhere at once — used by account/routes.ts's /delete handler. */
export function revokeAllSessionsForUser(userId: string): void {
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

export function userFromSessionToken(token: string): SessionUser | null {
  const tokenHash = sha256(token);
  const session = db.prepare(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`).get(tokenHash) as
    | SessionRow
    | undefined;
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(new Date().toISOString(), tokenHash);

  const user = db
    .prepare(
      `SELECT id, email, phone, email_verified, phone_verified, first_name, last_name, company, avatar_data_url,
              product_updates_opt_in, two_factor_enabled, password_hash, google_sub, deleted_at
       FROM users WHERE id = ?`,
    )
    .get(session.user_id) as UserRow | undefined;
  if (!user) return null;

  // A soft-deleted account (see users.ts's softDeleteUser) should be signed out
  // everywhere immediately, not just have new logins refused.
  if (user.deleted_at) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    emailVerified: !!user.email_verified,
    phoneVerified: !!user.phone_verified,
    firstName: user.first_name,
    lastName: user.last_name,
    company: user.company,
    avatarDataUrl: user.avatar_data_url,
    productUpdatesOptIn: !!user.product_updates_opt_in,
    twoFactorEnabled: !!user.two_factor_enabled,
    hasPassword: !!user.password_hash,
    hasGoogle: !!user.google_sub,
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.sessionCookieName, { path: '/' });
}

/** Express middleware: resolves the session cookie into `req.user`, 401s if absent/expired. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.sessionCookieName];
  const user = token ? userFromSessionToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = user;
  next();
}

/** Same check as requireSession, for the signed-in-only HTML pages (home/download/profile/
 * account/support) rather than the JSON API — a visitor with no valid session is bounced to
 * the marketing page instead of getting a bare 401, since these are full page loads, not
 * fetch() calls a script can handle. */
export function requirePageSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.sessionCookieName];
  const user = token ? userFromSessionToken(token) : null;
  if (!user) {
    res.redirect('/focusKube');
    return;
  }
  req.user = user;
  next();
}
