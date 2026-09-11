import { Router } from 'express';
import { db } from '../db.js';
import { requireSession } from '../auth/sessions.js';
import { createLicenseForUser } from '../licenseStore.js';

const router = Router();
export const accountRouter = router;

interface LicenseRow {
  key: string;
  plan: string;
  status: string;
  quota_remaining: number;
}

router.get('/', requireSession, (req, res) => {
  const license = db
    .prepare(`SELECT key, plan, status, quota_remaining FROM licenses WHERE user_id = ?`)
    .get(req.user!.id) as LicenseRow | undefined;

  res.json({
    user: req.user,
    license: license
      ? { key: license.key, plan: license.plan, status: license.status, quotaRemaining: license.quota_remaining }
      : null,
  });
});

// Rotates the user's key (e.g. if it leaked) without touching plan/quota/Stripe linkage.
router.post('/license/regenerate', requireSession, (req, res) => {
  const license = db
    .prepare(`SELECT plan, quota_remaining FROM licenses WHERE user_id = ?`)
    .get(req.user!.id) as { plan: string; quota_remaining: number } | undefined;
  if (!license) {
    res.status(400).json({ error: 'No active plan to regenerate a key for' });
    return;
  }
  const key = createLicenseForUser(req.user!.id, { plan: license.plan, quotaRemaining: license.quota_remaining });
  res.json({ key });
});
