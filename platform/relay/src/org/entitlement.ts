/** Resolves the license that actually entitles a user right now — their own personal
 * license, or the pooled Team license behind their seat, whichever applies. This is what
 * account/routes.ts's GET / returns, and therefore what the desktop app's aiLicenseStore
 * caches: a Team member has no other way to learn that their org's Pro plan covers them
 * (see platform/backend/src/runtime/aiLicenseStore.ts, which only reads
 * `license.{key,plan,status,quotaRemaining}` — kept unchanged below on purpose). */
import { db } from '../db.js';
import { getLicenseForUser, type LicenseWithKey } from '../licenseStore.js';
import { findActiveMembership } from './store.js';

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
export function getOrgLicenseForUser(userId: string): EffectiveLicense | undefined {
  const membership = findActiveMembership(userId);
  if (!membership || membership.org_status !== 'active') return undefined;
  const pool = db
    .prepare(`SELECT key, plan, status, quota_remaining, quota_granted, trial_ends_at FROM licenses WHERE org_id = ?`)
    .get(membership.org_id) as PoolLicenseRow | undefined;
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
 * Team membership are active, prefer Team — unless its pool is exhausted and the personal
 * license still has credits, in which case fall back to personal (avoids "I pay for Pro
 * myself but my team ran out of shared credits"). */
export function getEffectiveLicenseForUser(userId: string): EffectiveLicense | undefined {
  const personal = getLicenseForUser(userId);
  const org = getOrgLicenseForUser(userId);

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
