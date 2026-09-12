import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const profilePageRouter = router;

router.get('/profile', requirePageSession, (_req, res) => {
  res.type('html').send(page('Profile', renderTemplate('profile'), '/profile'));
});
