import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { proUnitAmountCents } from '../billing/pricing.js';
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
    PRO_PRICE_MONTHLY: (config.pricing.proPriceMonthlyCents / 100).toFixed(2),
    PRO_PRICE_ANNUAL_PER_MONTH: (proUnitAmountCents('year') / 12 / 100).toFixed(2),
    PRO_ANNUAL_DISCOUNT_PERCENT: String(config.pricing.annualDiscountPercent),
  });
  res.type('html').send(page('AI assistant for your clusters', body, '/home'));
});
