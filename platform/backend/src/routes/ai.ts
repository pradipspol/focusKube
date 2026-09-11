import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { HttpError } from '../util/httpError.js';
import { logError, logInfo } from '../util/logger.js';
import {
  getLicenseKey,
  setLicenseKey,
  clearLicenseKey,
  getCachedEntitlement,
  setCachedEntitlement,
  getCacheAge,
} from '../runtime/aiLicenseStore.js';

const router = Router();

interface EntitlementResponse {
  enabled: boolean;
  plan?: string;
  status?: string;
  quotaRemaining?: number;
  error?: string;
}

export const aiRouter = router;

// GET /api/ai/entitlement — Check if AI is available to this install
router.get('/entitlement', async (req: Request, res: Response<EntitlementResponse>, next: NextFunction) => {
  try {
    const licenseKey = await getLicenseKey();

    // No license key → AI disabled
    if (!licenseKey) {
      return res.json({ enabled: false });
    }

    // Check cache age
    const cacheAge = await getCacheAge();
    const isNegativeExpired =
      cacheAge > config.aiLicenseCheckNegativeCacheMs;
    const isPositiveExpired =
      cacheAge > config.aiLicenseCheckCacheMs;

    // If we have a cached entitlement and it's still fresh, use it
    const cached = await getCachedEntitlement();
    if (cached && !isPositiveExpired) {
      return res.json({
        enabled: cached.status === 'active',
        plan: cached.plan,
        status: cached.status,
        quotaRemaining: cached.quotaRemaining,
      });
    }

    // If cache is expired or we got a negative result before, re-validate
    if (isPositiveExpired || isNegativeExpired) {
      try {
        // Call relay to validate license
        const relayResponse = await fetch(
          `${config.aiRelayBaseUrl}/v1/license/validate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${licenseKey}`,
            },
            body: JSON.stringify({}),
          },
        );

        if (relayResponse.status === 401 || relayResponse.status === 403) {
          // License invalid or expired
          await clearLicenseKey();
          return res.json({ enabled: false, error: 'License invalid or expired' });
        }

        if (!relayResponse.ok) {
          logError('ai_license.relay_error', {
            status: relayResponse.status,
            statusText: relayResponse.statusText,
          });
          // On relay error, fall back to cached state if we have one
          if (cached) {
            return res.json({
              enabled: cached.status === 'active',
              plan: cached.plan,
              status: cached.status,
              quotaRemaining: cached.quotaRemaining,
            });
          }
          return res.status(503).json({
            enabled: false,
            error: 'License validation service temporarily unavailable',
          });
        }

        const entitlementData = (await relayResponse.json()) as {
          plan?: string;
          status?: string;
          quotaRemaining?: number;
        };
        await setCachedEntitlement(entitlementData);

        return res.json({
          enabled: entitlementData.status === 'active',
          plan: entitlementData.plan,
          status: entitlementData.status,
          quotaRemaining: entitlementData.quotaRemaining,
        });
      } catch (err) {
        logError('ai_license.validation_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall back to cached state
        if (cached) {
          return res.json({
            enabled: cached.status === 'active',
            plan: cached.plan,
            status: cached.status,
            quotaRemaining: cached.quotaRemaining,
          });
        }
        return res.status(503).json({
          enabled: false,
          error: 'Could not validate license (offline grace period: 72h)',
        });
      }
    }

    // Should not reach here, but be defensive
    return res.json({ enabled: false });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/license — Set license key
router.post('/license', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key } = req.body as { key?: string };

    if (!key || typeof key !== 'string') {
      throw new HttpError(400, 'License key required');
    }

    await setLicenseKey(key);
    logInfo('ai_license.posted', { keyPrefix: key.slice(0, 20) });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/license — Clear license key
router.delete('/license', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await clearLicenseKey();
    logInfo('ai_license.deleted');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
