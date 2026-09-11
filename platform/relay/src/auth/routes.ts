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

router.post('/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'A valid email and an 8+ character password are required' });
    return;
  }
  const normalizedEmail = normalizeEmail(email);
  if (findUserByEmail(normalizedEmail)) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = createUser({ email: normalizedEmail, password_hash: passwordHash });
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const user = findUserByEmail(normalizeEmail(email));
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
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
  if (!user) {
    user = createUser(
      channel === 'email' ? { email: normalized, email_verified: 1 } : { phone: normalized, phone_verified: 1 },
    );
  } else if (channel === 'email' && !user.email_verified) {
    markEmailVerified(user.id);
  } else if (channel === 'sms' && !user.phone_verified) {
    markPhoneVerified(user.id);
  }

  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
});

const OAUTH_STATE_COOKIE = 'fk_oauth_state';

router.get('/google/start', (_req, res) => {
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
  res.redirect(googleAuthUrl(state));
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/v1/auth/google' });

  if (!code || !state || !cookieState || state !== cookieState) {
    res.status(400).send('Invalid or expired sign-in attempt. Please try again.');
    return;
  }

  try {
    const profile = await verifyGoogleCode(code);

    let user = findUserByGoogleSub(profile.sub);
    if (!user && profile.email) {
      // Only link onto an existing account when Google itself vouches the email is
      // verified — otherwise a Google account created with an unverified address could
      // hijack someone else's existing focusKube account.
      const existing = findUserByEmail(normalizeEmail(profile.email));
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

    setSessionCookie(res, createSession(user.id));
    res.redirect('/dashboard');
  } catch (err) {
    res.status(400).send(`Google sign-in failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
});
