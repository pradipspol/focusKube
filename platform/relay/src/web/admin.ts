import { Router } from 'express';
import { requireAdminPage, requirePageSession } from '../auth/sessions.js';
import { adminPage, renderTemplate } from './layout.js';

const router = Router();
export const adminPageRouter = router;

const pages = [
  ['/admin', 'Admin', 'admin'],
  ['/admin/users', 'Users', 'admin-users'],
  ['/admin/telemetry', 'Telemetry', 'admin-telemetry'],
  ['/admin/preferences', 'Preferences', 'admin-preferences'],
  ['/admin/team-onboarding', 'Team onboarding', 'admin-team-onboarding'],
] as const;

for (const [route, title, template] of pages) {
  router.get(route, requirePageSession, requireAdminPage, (_req, res) => {
    res.type('html').send(adminPage(title, renderTemplate(template), route));
  });
}
