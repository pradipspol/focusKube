/**
 * DB-backed license store (SQLite via db.ts). Keeps the same external contract the
 * in-memory Phase 1 version had — `licenseFromAuthHeader`, `lookupLicense`,
 * `decrementQuota`, `devLicenseKey` — so index.ts's /v1/license/validate and
 * /v1/ai/chat handlers need no changes at all.
 *
 * License keys stay plaintext at rest (see db.ts) — the dashboard needs to re-display
 * a customer's key on demand, so this is a re-viewable credential, not a one-time secret.
 */
import crypto from 'node:crypto';
import { findUserById, markTrialStarted } from './auth/users.js';
import { config } from './config.js';
import { db } from './db.js';

export interface LicenseRecord {
  plan: string;
  status: 'active' | 'inactive' | 'expired';
  quotaRemaining: number;
  quotaGranted: number;
  trialEndsAt: string | null;
}

export interface LicenseWithKey extends LicenseRecord {
  key: string;
}

interface LicenseRow {
  key: string;
  plan: string;
  status: string;
  quota_remaining: number;
  quota_granted: number;
  trial_ends_at: string | null;
}

// The deliberate, user-initiated free trial (see account/routes.ts POST /trial/start)
// — distinct from billing/routes.ts's Stripe-not-configured checkout fallback, which
// keeps its own unlimited/no-expiry behavior for self-host/dev use.
export const FREE_TRIAL_PLAN = 'trial';
export const FREE_TRIAL_QUOTA = 100;
export const FREE_TRIAL_DURATION_DAYS = 14;

// A Team's pooled license (see org/*.ts) — lives here rather than in org/billing.ts to
// avoid a circular import (org/billing.ts already needs createOrgPoolLicense below).
export const TEAM_PLAN = 'team';

/** The Team pool's total credit grant for a given seat count. */
export function orgPoolSize(seats: number): number {
  return config.org.poolQuotaPerSeat * seats;
}

function toRecord(row: LicenseRow): LicenseRecord {
  return {
    plan: row.plan,
    status: row.status as LicenseRecord['status'],
    quotaRemaining: row.quota_remaining,
    quotaGranted: row.quota_granted,
    trialEndsAt: row.trial_ends_at,
  };
}

/** Lazily flips a trial license to 'expired' once its time limit has passed — there's no
 * job scheduler in this service, so every read path (lookupLicense/getLicenseForUser)
 * checks this first instead. Quota running out is already enforced separately wherever
 * quotaRemaining is checked (e.g. index.ts's /v1/ai/chat). */
function expireIfPastDeadline(key: string): void {
  db.prepare(
    `UPDATE licenses SET status = 'expired', updated_at = ?
     WHERE key = ? AND status = 'active' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?`,
  ).run(new Date().toISOString(), key, new Date().toISOString());
}

function seedDevLicenseIfEmpty(): void {
  const { c } = db.prepare(`SELECT COUNT(*) as c FROM licenses`).get() as { c: number };
  if (c > 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO licenses (id, key, user_id, plan, status, quota_remaining, created_at, updated_at)
     VALUES (?, ?, NULL, 'dev', 'active', 1000, ?, ?)`,
  ).run(crypto.randomUUID(), config.devLicenseKey, now, now);
}
seedDevLicenseIfEmpty();

export function devLicenseKey(): string {
  return config.devLicenseKey;
}

export function licenseFromAuthHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  const key = value.slice('Bearer '.length).trim();
  return key || null;
}

/** A raw key is either a direct `licenses.key` (personal/dev/org-pool key) or a Team
 * member's own seat key, which resolves through organization_members to its org's pool
 * row. Returns the underlying `licenses.key` either way, or undefined if neither matches. */
function resolveLicenseKey(key: string): string | undefined {
  const direct = db.prepare(`SELECT key FROM licenses WHERE key = ?`).get(key) as { key: string } | undefined;
  if (direct) return direct.key;
  const viaSeat = db
    .prepare(
      `SELECT l.key AS key FROM organization_members m
         JOIN licenses l ON l.org_id = m.org_id
        WHERE m.license_key = ? AND m.status = 'active'
        LIMIT 1`,
    )
    .get(key) as { key: string } | undefined;
  return viaSeat?.key;
}

export function lookupLicense(key: string): LicenseRecord | undefined {
  const resolvedKey = resolveLicenseKey(key);
  if (!resolvedKey) return undefined;
  expireIfPastDeadline(resolvedKey);
  const row = db
    .prepare(`SELECT plan, status, quota_remaining, quota_granted, trial_ends_at FROM licenses WHERE key = ?`)
    .get(resolvedKey) as LicenseRow | undefined;
  if (!row) return undefined;
  return toRecord(row);
}

/** Same lazy-expiry path as lookupLicense, keyed by account instead of license key — used
 * by GET /v1/account (and anywhere else that should see a trial flip to 'expired' the
 * moment its time limit passes, not just the next time the key itself is used). */
export function getLicenseForUser(userId: string): LicenseWithKey | undefined {
  const keyRow = db.prepare(`SELECT key FROM licenses WHERE user_id = ?`).get(userId) as { key: string } | undefined;
  if (!keyRow) return undefined;
  expireIfPastDeadline(keyRow.key);
  const row = db
    .prepare(`SELECT key, plan, status, quota_remaining, quota_granted, trial_ends_at FROM licenses WHERE user_id = ?`)
    .get(userId) as LicenseRow | undefined;
  if (!row) return undefined;
  return { ...toRecord(row), key: row.key };
}

export function hasHadTrial(userId: string): boolean {
  return !!findUserById(userId)?.trial_started_at;
}

/** Grants the one-time, deliberate free trial: capped by both quota and a time limit,
 * whichever is hit first (see expireIfPastDeadline for the time side, and the existing
 * quotaRemaining checks in index.ts for the quota side). Once per account, ever — tracked
 * on users.trial_started_at rather than the licenses row, since that row gets overwritten
 * by any later plan change (see createLicenseForUser). */
export function grantFreeTrial(userId: string): { key: string; trialEndsAt: string } | { alreadyUsed: true } {
  if (hasHadTrial(userId)) return { alreadyUsed: true };
  const trialEndsAt = new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const key = createLicenseForUser(userId, { plan: FREE_TRIAL_PLAN, quotaRemaining: FREE_TRIAL_QUOTA, trialEndsAt });
  markTrialStarted(userId);
  return { key, trialEndsAt };
}

/** Atomically takes one credit off whichever balance `key` resolves to — a personal
 * license row, or the pooled Team balance behind a seat key — in a single UPDATE, so two
 * seat keys hitting the same pool concurrently can't both pass the same check. Returns
 * false if the license isn't active or the balance was already 0; callers must reject the
 * request in that case rather than proceeding. Reserve *before* streaming a response
 * (index.ts's /v1/ai/chat), not after — decrementing only once the whole response has
 * already been sent is what let concurrent Team members over-spend one pool. */
export function reserveQuota(key: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE licenses
          SET quota_remaining = quota_remaining - 1, updated_at = @now
        WHERE quota_remaining > 0
          AND status = 'active'
          AND id = (
            SELECT id FROM licenses WHERE key = @key AND status = 'active'
            UNION ALL
            SELECT l.id FROM organization_members m
              JOIN licenses l ON l.org_id = m.org_id
             WHERE m.license_key = @key AND m.status = 'active'
             LIMIT 1
          )`,
    )
    .run({ key, now });
  if (result.changes === 0) return false;
  // Best-effort per-member usage attribution — a no-op update when `key` is a personal key.
  db.prepare(
    `UPDATE organization_members SET calls_used = calls_used + 1, updated_at = ? WHERE license_key = ? AND status = 'active'`,
  ).run(now, key);
  return true;
}

/** Gives back a credit reserved via reserveQuota when the call failed before producing a
 * response (e.g. the LLM call itself errored) — see index.ts's /v1/ai/chat catch block. */
export function refundQuota(key: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE licenses
        SET quota_remaining = quota_remaining + 1, updated_at = @now
      WHERE id = (
          SELECT id FROM licenses WHERE key = @key
          UNION ALL
          SELECT l.id FROM organization_members m
            JOIN licenses l ON l.org_id = m.org_id
           WHERE m.license_key = @key AND m.status = 'active'
           LIMIT 1
        )`,
  ).run({ key, now });
  db.prepare(
    `UPDATE organization_members SET calls_used = MAX(calls_used - 1, 0), updated_at = ? WHERE license_key = ? AND status = 'active'`,
  ).run(now, key);
}

/** Resets a license's quota_remaining back to its quota_granted at the start of each
 * billing cycle (see billing/routes.ts's new 'invoice.paid' webhook case) — for a Team
 * pool, quota_granted is also recomputed from the org's *current* seat count first, so a
 * seat-count change since the last cycle is picked up correctly. Trial licenses have no
 * stripe_subscription_id, so this is never called for them — the one-time trial grant is
 * unaffected. */
export function resetQuotaForSubscription(subscriptionId: string): void {
  const now = new Date().toISOString();
  const row = db
    .prepare(`SELECT id, org_id, quota_granted FROM licenses WHERE stripe_subscription_id = ?`)
    .get(subscriptionId) as { id: string; org_id: string | null; quota_granted: number } | undefined;
  if (!row) return;
  if (row.org_id) {
    const org = db.prepare(`SELECT seats_purchased FROM organizations WHERE id = ?`).get(row.org_id) as
      | { seats_purchased: number }
      | undefined;
    const granted = orgPoolSize(org?.seats_purchased ?? 0);
    db.prepare(`UPDATE licenses SET quota_granted = ?, quota_remaining = ?, updated_at = ? WHERE id = ?`).run(
      granted,
      granted,
      now,
      row.id,
    );
  } else {
    db.prepare(`UPDATE licenses SET quota_remaining = quota_granted, updated_at = ? WHERE id = ?`).run(now, row.id);
  }
}

/** Issues (or replaces) the one license a user account can hold. Used by Stripe webhook
 * handling, the manual "regenerate key" action, and grantFreeTrial above. `trialEndsAt`
 * defaults to null so a paid upgrade naturally clears any prior trial deadline. */
export function createLicenseForUser(
  userId: string,
  opts: { plan: string; quotaRemaining: number; trialEndsAt?: string | null },
): string {
  const key = `fk_live_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const trialEndsAt = opts.trialEndsAt ?? null;
  const existing = db.prepare(`SELECT id FROM licenses WHERE user_id = ?`).get(userId) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE licenses SET key = ?, plan = ?, status = 'active', quota_remaining = ?, quota_granted = ?, trial_ends_at = ?, updated_at = ? WHERE user_id = ?`,
    ).run(key, opts.plan, opts.quotaRemaining, opts.quotaRemaining, trialEndsAt, now, userId);
  } else {
    db.prepare(
      `INSERT INTO licenses (id, key, user_id, plan, status, quota_remaining, quota_granted, trial_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), key, userId, opts.plan, opts.quotaRemaining, opts.quotaRemaining, trialEndsAt, now, now);
  }
  return key;
}

/** The Team counterpart to createLicenseForUser above: issues (or replaces) the one pooled
 * license row an org can hold — org_id set, user_id NULL (see db.ts's schema comment on
 * this being already-legal). Used by org/billing.ts's activateOrgFromCheckout. */
export function createOrgPoolLicense(
  orgId: string,
  opts: {
    seats: number;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    currentPeriodEnd: string | null;
  },
): string {
  const key = `fk_org_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const granted = orgPoolSize(opts.seats);
  const existing = db.prepare(`SELECT id FROM licenses WHERE org_id = ?`).get(orgId) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE licenses SET key = ?, plan = ?, status = 'active', quota_granted = ?, quota_remaining = ?,
              stripe_customer_id = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ?,
              current_period_end = ?, updated_at = ? WHERE org_id = ?`,
    ).run(
      key,
      TEAM_PLAN,
      granted,
      granted,
      opts.stripeCustomerId,
      opts.stripeSubscriptionId,
      opts.stripeSubscriptionItemId,
      opts.currentPeriodEnd,
      now,
      orgId,
    );
  } else {
    db.prepare(
      `INSERT INTO licenses (id, key, org_id, plan, status, quota_remaining, quota_granted,
              stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, current_period_end,
              created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      key,
      orgId,
      TEAM_PLAN,
      granted,
      granted,
      opts.stripeCustomerId,
      opts.stripeSubscriptionId,
      opts.stripeSubscriptionItemId,
      opts.currentPeriodEnd,
      now,
      now,
    );
  }
  return key;
}

/** Adjusts a Team pool's grant by a seat *delta* rather than resetting it — so buying more
 * seats mid-cycle tops up proportionally without handing back credits already spent, and
 * dropping seats doesn't wipe credits already paid for. Used by org/billing.ts's
 * updateOrgSeats immediately after the Stripe quantity change (the webhook reconciles the
 * same value moments later via resetQuotaForSubscription's seat recompute, harmlessly). */
export function adjustOrgPoolForSeatChange(orgId: string, previousSeats: number, newSeats: number): void {
  const delta = orgPoolSize(newSeats) - orgPoolSize(previousSeats);
  if (delta === 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE licenses SET quota_granted = quota_granted + ?, quota_remaining = MAX(quota_remaining + ?, 0), updated_at = ? WHERE org_id = ?`,
  ).run(delta, delta, now, orgId);
}
