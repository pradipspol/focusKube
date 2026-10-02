import type { NextFunction, Request, Response } from 'express';
import type { Document } from 'mongodb';
import { config } from '../config.js';
import { mongoCollections } from '../mongoCollections.js';
import { logDebug, logInfo, updateLogContext } from '../logger.js';
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

export interface SessionRow extends Document {
  token_hash: string;
  user_id: string;
  expires_at: string;
}

interface UserRow extends Document {
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
export async function createSession(userId: string): Promise<string> {
  logDebug('Creating user session', { userId });
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await mongoCollections.sessions.insertOne({
    token_hash: sha256(token),
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_seen_at: now.toISOString(),
  });
  logInfo('User session created', { userId, expiresAt: expiresAt.toISOString() });
  return token;
}

export async function revokeSession(token: string): Promise<void> {
  const result = await mongoCollections.sessions.deleteOne({ token_hash: sha256(token) });
  logInfo('User session revocation completed', { removed: result.deletedCount > 0 });
}

/** Signs an account out everywhere at once Ã¢â‚¬â€ used by account/routes.ts's /delete handler. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const result = await mongoCollections.sessions.deleteMany({ user_id: userId });
  logInfo('All user sessions revoked', { userId, sessionsRemoved: result.deletedCount });
}

export async function userFromSessionToken(token: string): Promise<SessionUser | null> {
  const tokenHash = sha256(token);
  const sessions = mongoCollections.sessions;
  const session = await sessions.findOne({ token_hash: tokenHash });
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await sessions.deleteOne({ token_hash: tokenHash });
    logDebug('Expired user session removed', { userId: session.user_id });
    return null;
  }
  await sessions.updateOne({ token_hash: tokenHash }, { $set: { last_seen_at: new Date().toISOString() } });

  const user = await mongoCollections.users.findOne({ id: session.user_id });
  if (!user) return null;

  // A soft-deleted account (see users.ts's softDeleteUser) should be signed out
  // everywhere immediately, not just have new logins refused.
  if (user.deleted_at) {
    await sessions.deleteOne({ token_hash: tokenHash });
    logInfo('Session removed for deleted user account', { userId: user.id });
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
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[config.sessionCookieName];
  const user = token ? await userFromSessionToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = user;
  updateLogContext({ userId: user.id });
  next();
}

/** Same check as requireSession, for the signed-in-only HTML pages (home/download/profile/
 * account/support) rather than the JSON API Ã¢â‚¬â€ a visitor with no valid session is bounced to
 * the marketing page instead of getting a bare 401, since these are full page loads, not
 * fetch() calls a script can handle. */
export async function requirePageSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[config.sessionCookieName];
  const user = token ? await userFromSessionToken(token) : null;
  if (!user) {
    res.redirect('/focusKube');
    return;
  }
  req.user = user;
  updateLogContext({ userId: user.id });
  next();
}
