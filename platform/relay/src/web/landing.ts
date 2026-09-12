import { Router } from 'express';
import { proUnitAmountCents } from '../billing/pricing.js';
import { config } from '../config.js';
import { FREE_TRIAL_DURATION_DAYS, FREE_TRIAL_QUOTA } from '../licenseStore.js';
import { landingPage, renderTemplate } from './layout.js';

const router = Router();
export const landingPageRouter = router;

// Standalone marketing entry point — no sidebar, no signed-in-state chrome (see
// layout.ts's landingPage()). Distinct from /home, which lives inside the full app
// shell and also handles the signed-in "manage your plan" view.
router.get('/focusKube', (_req, res) => {
  const body = renderTemplate('landing', {
    TRIAL_QUOTA: String(FREE_TRIAL_QUOTA),
    TRIAL_DAYS: String(FREE_TRIAL_DURATION_DAYS),
    PRO_QUOTA: String(config.pricing.proQuota),
    PRO_PRICE_MONTHLY: (config.pricing.proPriceMonthlyCents / 100).toFixed(2),
    PRO_PRICE_ANNUAL_PER_MONTH: (proUnitAmountCents('year') / 12 / 100).toFixed(2),
    PRO_ANNUAL_DISCOUNT_PERCENT: String(config.pricing.annualDiscountPercent),
    ORG_MIN_SEATS: String(config.org.minSeats),
  });
  res.type('html').send(landingPage('AI assistant for your clusters', body));
});
