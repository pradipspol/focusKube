import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { activeProvider } from '../billing/provider.js';
import { config } from '../config.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const teamPageRouter = router;

// Signed-in-only, same as home/download/profile/account/support — the page itself fetches
// GET /v1/org client-side and renders "you don't have a team yet" when that comes back null.
router.get('/team', requirePageSession, (_req, res) => {
  const body = renderTemplate('team', {
    MIN_SEATS: String(config.org.minSeats),
    MAX_SEATS: String(config.org.maxSeats),
    // Was hardcoded as "10% off" in the template while the landing page templated it.
    ANNUAL_DISCOUNT_PERCENT: String(config.pricing.annualDiscountPercent),
    // Razorpay has no hosted billing portal — drop the button rather than offer a 503.
    SUPPORTS_PORTAL: String(activeProvider().supportsPortal()),
  });
  res.type('html').send(page('Team', body, '/team'));
});
