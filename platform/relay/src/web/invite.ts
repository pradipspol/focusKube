import { Router } from 'express';
import { authPage, renderTemplate } from './layout.js';

const router = Router();
export const invitePageRouter = router;

// Public (no requirePageSession) — a person clicking an emailed invite link may not be
// signed in yet, or may not even have an account (see invite.html's own auth branching via
// GET /v1/auth/me and GET /v1/org/invites/by-token/:token).
router.get('/invite', (_req, res) => {
  res.type('html').send(authPage('Team invite', renderTemplate('invite')));
});
