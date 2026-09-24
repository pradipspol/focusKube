import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { activeProvider } from '../billing/provider.js';
import { config } from '../config.js';
import { FREE_TRIAL_DURATION_DAYS, FREE_TRIAL_QUOTA } from '../licenseStore.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const homeRouter = router;

// Signed-in-only — a guest lands on /focusKube instead (see requirePageSession).
router.get('/home', requirePageSession, (_req, res) => {
  const body = renderTemplate('home', {
    TRIAL_QUOTA: String(FREE_TRIAL_QUOTA),
    TRIAL_DAYS: String(FREE_TRIAL_DURATION_DAYS),
    PRO_QUOTA: String(config.pricing.proQuota),
    // Razorpay has no hosted billing portal, so the template drops that button entirely
    // rather than offering one that always 503s.
    SUPPORTS_PORTAL: String(activeProvider().supportsPortal()),
    PRO_ANNUAL_DISCOUNT_PERCENT: String(config.pricing.annualDiscountPercent),
  });
  res.type('html').send(page('AI assistant for your clusters', body, '/home'));
});
