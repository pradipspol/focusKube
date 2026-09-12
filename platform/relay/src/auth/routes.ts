import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { db } from '../db.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../notify/email.js';
import { sendOtpSms } from '../notify/sms.js';
import { randomToken, sha256 } from './crypto.js';
import { googleAuthUrl, isGoogleConfigured, verifyGoogleCode } from './google.js';
import { createOtp, recentOtpCount, verifyOtp } from './otp.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { clearSessionCookie, createSession, requireSession, revokeSession, setSessionCookie } from './sessions.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByGoogleSub,
  findUserByPhone,
  linkGoogleSub,
  markEmailVerified,
  markPhoneVerified,
  setPassword,
} from './users.js';

const router = Router();
export const authRouter = router;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately permissive (matches the HTML5 type="email" spirit) — this only guards
// against obviously malformed input server-side; the client's own check (signup.html)
// is what gives the user immediate feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/signup', authLimiter, async (req, res) => {
  const { email, password, firstName, lastName } = req.body as {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
  };
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'An 8+ character password is required' });
    return;
  }
  const normalizedEmail = normalizeEmail(email);
  if (findUserByEmail(normalizedEmail)) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = createUser({
    email: normalizedEmail,
    password_hash: passwordHash,
    first_name: firstName?.trim() || null,
    last_name: lastName?.trim() || null,
  });
  const token = createSession(user.id);
  setSessionCookie(res, token);
  // sessionToken lets a server-to-server caller (a self-hosted focusKube backend proxying
  // this call on a user's behalf) capture the token directly instead of parsing Set-Cookie
  // off the fetch response. The relay's own browser-facing web pages just ignore this field.
  res.json({ ok: true, sessionToken: token });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const user = findUserByEmail(normalizeEmail(email));
  // A deleted account fails the same way as a wrong password — this must not be usable
  // to tell a deleted account apart from one that never existed.
  if (!user?.password_hash || user.deleted_at || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (user.two_factor_enabled) {
    // Second factor: a one-time code emailed after the password already checked out (see
    // POST /2fa/verify below, and account/routes.ts's POST /2fa for the enable/disable
    // toggle). No session is created until that code is verified too.
    const code = createOtp(user.email!, 'email', TWO_FACTOR_OTP_PURPOSE);
    await sendOtpEmail(user.email!, code);
    res.json({ twoFactorRequired: true, email: user.email });
    return;
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, sessionToken: token });
});

router.post('/2fa/verify', authLimiter, (req, res) => {
  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) {
    res.status(400).json({ error: 'email and code are required' });
    return;
  }
  const normalized = normalizeEmail(email);
  const result = verifyOtp(normalized, TWO_FACTOR_OTP_PURPOSE, code);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const user = findUserByEmail(normalized);
  if (!user || user.deleted_at) {
    res.status(400).json({ error: 'This account is no longer available' });
    return;
  }
  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, sessionToken: token });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[config.sessionCookieName];
  if (token) revokeSession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireSession, (req, res) => {
  res.json({ user: req.user });
});

router.post('/password/reset-request', authLimiter, async (req, res) => {
  const { email } = req.body as { email?: string };
  // Always 200, regardless of whether the account exists — this endpoint must not
  // be usable to enumerate registered emails.
  if (email) {
    const user = findUserByEmail(normalizeEmail(email));
    if (user?.email) {
      const token = randomToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.passwordResetTtlMinutes * 60 * 1000);
      db.prepare(
        `INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      ).run(sha256(token), user.id, now.toISOString(), expiresAt.toISOString());
      await sendPasswordResetEmail(user.email, token);
    }
  }
  res.json({ ok: true });
});

router.post('/password/reset-confirm', authLimiter, async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token || !password || password.length < 8) {
    res.status(400).json({ error: 'A valid token and an 8+ character password are required' });
    return;
  }
  const tokenHash = sha256(token);
  const row = db
    .prepare(`SELECT user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ?`)
    .get(tokenHash) as { user_id: string; expires_at: string; consumed_at: string | null } | undefined;
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'This reset link is invalid or has expired' });
    return;
  }
  const passwordHash = await hashPassword(password);
  setPassword(row.user_id, passwordHash);
  db.prepare(`UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ?`).run(
    new Date().toISOString(),
    tokenHash,
  );
  res.json({ ok: true });
});

const OTP_PURPOSE = 'login';
const TWO_FACTOR_OTP_PURPOSE = '2fa-login';

router.post('/otp/request', authLimiter, async (req, res) => {
  const { destination, channel } = req.body as { destination?: string; channel?: 'email' | 'sms' };
  if (!destination || (channel !== 'email' && channel !== 'sms')) {
    res.status(400).json({ error: 'destination and channel ("email" or "sms") are required' });
    return;
  }
  const normalized = channel === 'email' ? normalizeEmail(destination) : destination.trim();

  // Per-destination throttle on top of the per-IP rate limiter above — otherwise someone
  // could SMS-bomb a phone number they don't own from many different IPs.
  if (recentOtpCount(normalized, OTP_PURPOSE, 10 * 60 * 1000) >= 3) {
    res.status(429).json({ error: 'Too many codes requested for this destination — try again later' });
    return;
  }

  const code = createOtp(normalized, channel, OTP_PURPOSE);
  if (channel === 'email') {
    await sendOtpEmail(normalized, code);
  } else {
    await sendOtpSms(normalized, code);
  }
  res.json({ ok: true });
});

router.post('/otp/verify', authLimiter, (req, res) => {
  const { destination, channel, code } = req.body as {
    destination?: string;
    channel?: 'email' | 'sms';
    code?: string;
  };
  if (!destination || !code || (channel !== 'email' && channel !== 'sms')) {
    res.status(400).json({ error: 'destination, channel, and code are required' });
    return;
  }
  const normalized = channel === 'email' ? normalizeEmail(destination) : destination.trim();

  const result = verifyOtp(normalized, OTP_PURPOSE, code);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  // Verifying a code IS proof of ownership of that email/phone — safe to trust it enough
  // to both create the account (if new) and mark that channel verified (if existing).
  let user = channel === 'email' ? findUserByEmail(normalized) : findUserByPhone(normalized);
  if (user?.deleted_at) {
    res.status(403).json({ error: 'This account is no longer available' });
    return;
  }
  if (!user) {
    user = createUser(
      channel === 'email' ? { email: normalized, email_verified: 1 } : { phone: normalized, phone_verified: 1 },
    );
  } else if (channel === 'email' && !user.email_verified) {
    markEmailVerified(user.id);
  } else if (channel === 'sms' && !user.phone_verified) {
    markPhoneVerified(user.id);
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, sessionToken: token });
});

const OAUTH_STATE_COOKIE = 'fk_oauth_state';
const OAUTH_REDIRECT_COOKIE = 'fk_oauth_app_redirect';
// Carries a same-origin "return to this page after signing in" path (e.g. the org invite
// accept flow's /invite?token=... — see org/routes.ts) across the Google redirect chain.
// Deliberately separate from OAUTH_REDIRECT_COOKIE/validatedAppRedirect above: that one
// carries a full external app URL for a self-hosted backend's OAuth flow; this one only
// ever carries a relative path on this relay's own web pages.
const POST_AUTH_NEXT_COOKIE = 'fk_post_auth_next';

/** Same-origin-relative paths only — rejects an absolute URL, a protocol-relative "//host"
 * path, or anything with a scheme, closing off the open-redirect this could otherwise be. */
function validatedNextPath(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  try {
    // Resolving against a fixed dummy origin is just a parser: if new URL() changes the
    // path (e.g. it actually carried a scheme), the input wasn't a plain relative path.
    const url = new URL(raw, 'http://fk-relative.invalid');
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/**
 * Exact-origin match against the configured allowlist — never a prefix/substring check, to
 * close off open-redirect abuse — OR any loopback origin (any port). The loopback carve-out
 * matters because a desktop install's local static server picks its port dynamically
 * (falling back across a wide range if its preferred port is taken), so it can't always be
 * enumerated in advance; only locally-running software can ever bind a loopback port on the
 * user's own machine, so trusting "any localhost/127.0.0.1 port" is the same reasoning
 * native-app OAuth (RFC 8252) already relies on for loopback redirect URIs.
 */
function validatedAppRedirect(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return url.toString();
    }
    const allowed = config.allowedAppRedirects.some((entry) => {
      try {
        return new URL(entry).origin === url.origin;
      } catch {
        return false;
      }
    });
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

router.get('/google/start', (req, res) => {
  if (!isGoogleConfigured()) {
    res.status(503).send('Google sign-in is not configured on this server.');
    return;
  }
  const state = randomToken(16);
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: 10 * 60 * 1000,
    path: '/v1/auth/google',
  });

  // Present when a self-hosted focusKube backend (not this relay's own web pages) kicked off
  // the flow — carries the browser back to that backend's own callback route once we're done,
  // instead of to this relay's /account.
  const appRedirect = validatedAppRedirect(
    typeof req.query.app_redirect === 'string' ? req.query.app_redirect : undefined,
  );
  if (appRedirect) {
    res.cookie(OAUTH_REDIRECT_COOKIE, appRedirect, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 10 * 60 * 1000,
      path: '/v1/auth/google',
    });
  } else {
    res.clearCookie(OAUTH_REDIRECT_COOKIE, { path: '/v1/auth/google' });
  }

  const next = validatedNextPath(typeof req.query.next === 'string' ? req.query.next : undefined);
  if (next) {
    res.cookie(POST_AUTH_NEXT_COOKIE, next, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 10 * 60 * 1000,
      path: '/v1/auth/google',
    });
  } else {
    res.clearCookie(POST_AUTH_NEXT_COOKIE, { path: '/v1/auth/google' });
  }

  res.redirect(googleAuthUrl(state));
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
  const appRedirect = req.cookies?.[OAUTH_REDIRECT_COOKIE];
  const next = req.cookies?.[POST_AUTH_NEXT_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/v1/auth/google' });
  res.clearCookie(OAUTH_REDIRECT_COOKIE, { path: '/v1/auth/google' });
  res.clearCookie(POST_AUTH_NEXT_COOKIE, { path: '/v1/auth/google' });

  if (!code || !state || !cookieState || state !== cookieState) {
    res.status(400).send('Invalid or expired sign-in attempt. Please try again.');
    return;
  }

  try {
    const profile = await verifyGoogleCode(code);

    let user = findUserByGoogleSub(profile.sub);
    if (user?.deleted_at) {
      res.status(403).send('This account is no longer available.');
      return;
    }
    if (!user && profile.email) {
      // Only link onto an existing account when Google itself vouches the email is
      // verified — otherwise a Google account created with an unverified address could
      // hijack someone else's existing focusKube account.
      const existing = findUserByEmail(normalizeEmail(profile.email));
      if (existing?.deleted_at) {
        res.status(403).send('This account is no longer available.');
        return;
      }
      if (existing && profile.emailVerified) {
        linkGoogleSub(existing.id, profile.sub);
        if (!existing.email_verified) markEmailVerified(existing.id);
        user = existing;
      }
    }
    if (!user) {
      user = createUser({
        email: profile.email ? normalizeEmail(profile.email) : null,
        google_sub: profile.sub,
        email_verified: profile.emailVerified ? 1 : 0,
      });
    }

    if (appRedirect) {
      // App-initiated flow: hand back a short-lived, single-use code instead of putting the
      // real session token in the browser's address bar/history — the backend exchanges it
      // server-to-server via POST /session/exchange.
      const handoff = randomToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
      db.prepare(
        `INSERT INTO oauth_handoffs (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      ).run(sha256(handoff), user.id, now.toISOString(), expiresAt.toISOString());
      const redirectUrl = new URL(appRedirect);
      redirectUrl.searchParams.set('handoff', handoff);
      res.redirect(redirectUrl.toString());
      return;
    }

    setSessionCookie(res, createSession(user.id));
    res.redirect(next && validatedNextPath(next) ? next : '/home');
  } catch (err) {
    res.status(400).send(`Google sign-in failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
});

router.post('/session/exchange', (req, res) => {
  const { handoff } = req.body as { handoff?: string };
  if (!handoff) {
    res.status(400).json({ error: 'handoff is required' });
    return;
  }
  const tokenHash = sha256(handoff);
  const row = db
    .prepare(`SELECT user_id, expires_at, consumed_at FROM oauth_handoffs WHERE token_hash = ?`)
    .get(tokenHash) as { user_id: string; expires_at: string; consumed_at: string | null } | undefined;
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'This sign-in attempt is invalid or has expired' });
    return;
  }
  db.prepare(`UPDATE oauth_handoffs SET consumed_at = ? WHERE token_hash = ?`).run(
    new Date().toISOString(),
    tokenHash,
  );

  const user = findUserById(row.user_id);
  if (!user) {
    res.status(400).json({ error: 'Account no longer exists' });
    return;
  }
  const sessionToken = createSession(user.id);
  res.json({
    sessionToken,
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      emailVerified: !!user.email_verified,
      phoneVerified: !!user.phone_verified,
    },
  });
});
