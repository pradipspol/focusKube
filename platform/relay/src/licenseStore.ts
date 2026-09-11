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
import { config } from './config.js';
import { db } from './db.js';

export interface LicenseRecord {
  plan: string;
  status: 'active' | 'inactive' | 'expired';
  quotaRemaining: number;
}

interface LicenseRow {
  key: string;
  plan: string;
  status: string;
  quota_remaining: number;
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

export function lookupLicense(key: string): LicenseRecord | undefined {
  const row = db.prepare(`SELECT plan, status, quota_remaining FROM licenses WHERE key = ?`).get(key) as
    | LicenseRow
    | undefined;
  if (!row) return undefined;
  return { plan: row.plan, status: row.status as LicenseRecord['status'], quotaRemaining: row.quota_remaining };
}

export function decrementQuota(key: string): void {
  db.prepare(
    `UPDATE licenses SET quota_remaining = MAX(quota_remaining - 1, 0), updated_at = ? WHERE key = ? AND quota_remaining > 0`,
  ).run(new Date().toISOString(), key);
}

/** Issues (or replaces) the one license a user account can hold. Used by Stripe webhook
 * handling once billing lands, and by a future manual "regenerate key" action. */
export function createLicenseForUser(userId: string, opts: { plan: string; quotaRemaining: number }): string {
  const key = `fk_live_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id FROM licenses WHERE user_id = ?`).get(userId) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE licenses SET key = ?, plan = ?, status = 'active', quota_remaining = ?, updated_at = ? WHERE user_id = ?`,
    ).run(key, opts.plan, opts.quotaRemaining, now, userId);
  } else {
    db.prepare(
      `INSERT INTO licenses (id, key, user_id, plan, status, quota_remaining, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(crypto.randomUUID(), key, userId, opts.plan, opts.quotaRemaining, now, now);
  }
  return key;
}
