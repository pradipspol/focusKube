import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { config } from '../config.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const supportPageRouter = router;

router.get('/support', requirePageSession, (_req, res) => {
  const issuesUrl = `https://github.com/${config.githubRepo}/issues`;
  res.type('html').send(page('Support', renderTemplate('support', { ISSUES_URL: issuesUrl }), '/support'));
});
