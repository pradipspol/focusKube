import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { config } from '../config.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const downloadRouter = router;

router.get('/download', requirePageSession, (_req, res) => {
  const releasesUrl = `https://github.com/${config.githubRepo}/releases/latest`;
  res.type('html').send(page('Download', renderTemplate('download', { RELEASES_URL: releasesUrl }), '/download'));
});
