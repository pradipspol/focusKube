/** Resolves the license that actually entitles a user right now Ã¢â‚¬â€ their own personal
 * license, or the pooled Team license behind their seat, whichever applies. This is what
 * account/routes.ts's GET / returns, and therefore what the desktop app's aiLicenseStore
 * caches: a Team member has no other way to learn that their org's Pro plan covers them
 * (see platform/backend/src/runtime/aiLicenseStore.ts, which only reads
 * `license.{key,plan,status,quotaRemaining}` Ã¢â‚¬â€ kept unchanged below on purpose). */
import { mongoCollections } from '../mongoCollections.js';
import { getLicenseForUser, type LicenseWithKey } from '../licenseStore.js';
import { organizationService } from './organizationService.js';

export type LicenseScope = 'user' | 'org';

export interface EffectiveLicense extends LicenseWithKey {
  scope: LicenseScope;
  org?: { id: string; name: string; role: 'owner' | 'member' };
}

interface PoolLicenseRow {
  key: string;
  plan: string;
  status: string;
  quota_remaining: number;
  quota_granted: number;
  trial_ends_at: string | null;
}

/** The pooled Team license behind a user's active seat, if they have one and it's active. */
export async function getOrgLicenseForUser(userId: string): Promise<EffectiveLicense | undefined> {
  const membership = await organizationService.findActiveMembership(userId);
  if (!membership || membership.org_status !== 'active') return undefined;
  const pool = await mongoCollections.licenses.findOne({ org_id: membership.org_id }) ?? undefined;
  if (!pool) return undefined;
  return {
    key: membership.license_key,
    plan: pool.plan,
    status: pool.status as EffectiveLicense['status'],
    quotaRemaining: pool.quota_remaining,
    quotaGranted: pool.quota_granted,
    trialEndsAt: pool.trial_ends_at,
    scope: 'org',
    org: { id: membership.org_id, name: membership.org_name, role: membership.role },
  };
}

/** Precedence: an active license beats an inactive one. When both a personal license and
 * Team membership are active, prefer Team Ã¢â‚¬â€ unless its pool is exhausted and the personal
 * license still has credits, in which case fall back to personal (avoids "I pay for Pro
 * myself but my team ran out of shared credits"). */
export async function getEffectiveLicenseForUser(userId: string): Promise<EffectiveLicense | undefined> {
  const [personal, org] = await Promise.all([getLicenseForUser(userId), getOrgLicenseForUser(userId)]);

  const personalActive = personal?.status === 'active';
  const orgActive = org?.status === 'active';

  if (orgActive && org) {
    const orgExhausted = org.quotaRemaining <= 0;
    const personalHasCredits = personalActive && (personal?.quotaRemaining ?? 0) > 0;
    if (!(orgExhausted && personalHasCredits)) return org;
  }
  if (personal) return { ...personal, scope: 'user' };
  return orgActive ? org : undefined;
}
