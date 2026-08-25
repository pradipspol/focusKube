import { Router } from 'express';
import { clearDesktopAuthState } from '../auth/session.js';
import { setRequestOperation } from '../util/requestOp.js';
import { withRouteErrorLogging } from '../util/httpError.js';

export const authRouter = Router();

/** Public: lets the frontend decide which sign-in UI to render. */
authRouter.get('/config', withRouteErrorLogging('auth', 'GET /config', (_req, res) => {
  setRequestOperation(_req, 'auth.config');
  res.json({ mode: 'desktop' as const });
}));

authRouter.get('/me', withRouteErrorLogging('auth', 'GET /me', (req, res) => {
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
}));

authRouter.post('/signout', withRouteErrorLogging('auth', 'POST /signout', async (_req, res) => {
  setRequestOperation(_req, 'auth.signout');
  clearDesktopAuthState();
  res.json({ ok: true });
}));
