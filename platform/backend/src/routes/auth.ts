import { Router } from 'express';
import { config } from '../config.js';
import { clearSessionToken, getSessionToken, setSessionToken } from '../runtime/accountStore.js';
import { setRequestOperation } from '../util/requestOp.js';
import { withRouteErrorLogging } from '../util/httpError.js';

export const authRouter = Router();

interface RelayAuthResponse {
  ok?: boolean;
  error?: string;
  sessionToken?: string;
}

/** POSTs to the relay's own auth endpoints server-to-server — the frontend never talks to
 * the relay directly, same boundary already used for AI licensing (aiService.ts). */
async function callRelayAuth(relayPath: string, body: unknown): Promise<{ status: number; body: RelayAuthResponse }> {
  const response = await fetch(`${config.aiRelayBaseUrl}${relayPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as RelayAuthResponse;
  return { status: response.status, body: json };
}

/** Shared by signup/login/otp-verify: proxy to the relay, and on success capture the
 * session token it returns into this backend's own local account store. */
async function proxyAndCaptureSession(relayPath: string, body: unknown, res: import('express').Response): Promise<void> {
  const { status, body: relayBody } = await callRelayAuth(relayPath, body);
  if (status < 200 || status >= 300 || !relayBody.sessionToken) {
    res.status(status >= 400 ? status : 502).json({ error: relayBody.error ?? 'Sign-in failed' });
    return;
  }
  await setSessionToken(relayBody.sessionToken);
  res.json({ ok: true });
}

authRouter.get(
  '/config',
  withRouteErrorLogging('auth', 'GET /config', (req, res) => {
    setRequestOperation(req, 'auth.config');
    res.json({ mode: 'account' as const, signedIn: !!req.authUser });
  }),
);

authRouter.get(
  '/me',
  withRouteErrorLogging('auth', 'GET /me', (req, res) => {
    setRequestOperation(req, 'auth.me');
    if (!req.authUser) {
      res.status(401).json({ user: null });
      return;
    }
    res.json({
      user: {
        id: req.authUser.id,
        email: req.authUser.email,
        role: req.authUser.role,
      },
    });
  }),
);

authRouter.post(
  '/signup',
  withRouteErrorLogging('auth', 'POST /signup', async (req, res) => {
    setRequestOperation(req, 'auth.signup');
    const { email, password } = req.body as { email?: string; password?: string };
    await proxyAndCaptureSession('/v1/auth/signup', { email, password }, res);
  }),
);

authRouter.post(
  '/login',
  withRouteErrorLogging('auth', 'POST /login', async (req, res) => {
    setRequestOperation(req, 'auth.login');
    const { email, password } = req.body as { email?: string; password?: string };
    await proxyAndCaptureSession('/v1/auth/login', { email, password }, res);
  }),
);

authRouter.post(
  '/otp/request',
  withRouteErrorLogging('auth', 'POST /otp/request', async (req, res) => {
    setRequestOperation(req, 'auth.otp.request');
    const { destination, channel } = req.body as { destination?: string; channel?: 'email' | 'sms' };
    const { status, body } = await callRelayAuth('/v1/auth/otp/request', { destination, channel });
    res.status(status).json(body);
  }),
);

authRouter.post(
  '/otp/verify',
  withRouteErrorLogging('auth', 'POST /otp/verify', async (req, res) => {
    setRequestOperation(req, 'auth.otp.verify');
    const { destination, channel, code } = req.body as {
      destination?: string;
      channel?: 'email' | 'sms';
      code?: string;
    };
    await proxyAndCaptureSession('/v1/auth/otp/verify', { destination, channel, code }, res);
  }),
);

authRouter.post(
  '/signout',
  withRouteErrorLogging('auth', 'POST /signout', async (req, res) => {
    setRequestOperation(req, 'auth.signout');
    const token = await getSessionToken();
    if (token) {
      try {
        // Best-effort: actually revoke it server-side, not just forget it locally. A failed
        // revoke call (relay unreachable) shouldn't block signing out of this install.
        await fetch(`${config.aiRelayBaseUrl}/v1/auth/logout`, {
          method: 'POST',
          headers: { Cookie: `${config.accountSessionCookieName}=${token}` },
        });
      } catch {
        // Ignore — local sign-out still proceeds below.
      }
    }
    await clearSessionToken();
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/google/start',
  withRouteErrorLogging('auth', 'GET /google/start', (req, res) => {
    setRequestOperation(req, 'auth.google.start');
    // The frontend can be reached at very different origins depending on how focusKube is
    // running (Vite dev server, Electron's dynamically-ported local static server, or a real
    // self-hosted domain) — Referer reliably carries whichever one the browser was actually
    // on when it navigated here, since both proxies rewrite only the Host header (changeOrigin),
    // never Referer. Falls back to the configured app base URL if Referer is missing.
    const referer = req.get('referer');
    let frontendOrigin = config.appBaseUrl;
    if (referer) {
      try {
        frontendOrigin = new URL(referer).origin;
      } catch {
        // keep the fallback
      }
    }
    const appRedirect = `${frontendOrigin}/api/auth/google/complete`;
    res.redirect(`${config.aiRelayBaseUrl}/v1/auth/google/start?app_redirect=${encodeURIComponent(appRedirect)}`);
  }),
);

authRouter.get(
  '/google/complete',
  withRouteErrorLogging('auth', 'GET /google/complete', async (req, res) => {
    setRequestOperation(req, 'auth.google.complete');
    const handoff = typeof req.query.handoff === 'string' ? req.query.handoff : undefined;
    if (!handoff) {
      res.status(400).send('Missing sign-in code. Please try signing in again.');
      return;
    }

    const { status, body } = await callRelayAuth('/v1/auth/session/exchange', { handoff });
    if (status < 200 || status >= 300 || !body.sessionToken) {
      res.status(400).send(body.error ?? 'Google sign-in failed or expired. Please try signing in again.');
      return;
    }

    await setSessionToken(body.sessionToken);
    // Reached via the frontend's own origin (proxied through to this backend, same as every
    // other /api/* call) — so a plain relative redirect lands back on the app correctly
    // regardless of which origin that actually was.
    res.redirect('/');
  }),
);
