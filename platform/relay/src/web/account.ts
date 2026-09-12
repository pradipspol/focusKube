import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const accountPageRouter = router;

// Old URL, kept working — see auth/routes.ts and billing/routes.ts for the redirects
// that now point here instead.
router.get('/dashboard', (_req, res) => res.redirect(301, '/account'));

router.get('/account', requirePageSession, (_req, res) => {
  res.type('html').send(page('Account', renderTemplate('account'), '/account'));
});
