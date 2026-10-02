import crypto from 'node:crypto';
import type { ClientSession, Document } from 'mongodb';
import { userService } from './auth/userService.js';
import { config } from './config.js';
import { withTransaction } from './db.js';
import { mongoCollections } from './mongoCollections.js';
import { logDebug, logInfo, logWarning } from './logger.js';

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

export interface LicenseRow extends Document {
  id: string;
  key: string;
  user_id?: string | null;
  org_id?: string | null;
  plan: string;
  status: string;
  quota_remaining: number;
  quota_granted: number;
  trial_ends_at: string | null;
  stripe_subscription_id?: string | null;
  stripe_customer_id?: string | null;
  billing_provider?: string | null;
}

export const FREE_TRIAL_PLAN = 'trial';
export const FREE_TRIAL_QUOTA = 100;
export const FREE_TRIAL_DURATION_DAYS = 14;
export const TEAM_PLAN = 'team';

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

export async function initializeLicenseStore(): Promise<void> {
  const licenses = mongoCollections.licenses;
  if (await licenses.findOne({}, { projection: { _id: 1 } })) return;
  const now = new Date().toISOString();
  try {
    await licenses.insertOne({
      id: crypto.randomUUID(), key: config.devLicenseKey, user_id: null,
      plan: 'dev', status: 'active', quota_remaining: 1000, quota_granted: 1000,
      trial_ends_at: null, created_at: now, updated_at: now,
    });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
  }
}

export function devLicenseKey(): string {
  return config.devLicenseKey;
}

export function licenseFromAuthHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  const key = value.slice('Bearer '.length).trim();
  return key || null;
}

async function findLicenseForKey(key: string): Promise<LicenseRow | undefined> {
  const licenses = mongoCollections.licenses;
  const direct = await licenses.findOne({ key });
  if (direct) return direct;
  const member = await mongoCollections.organization_members.findOne({ license_key: key, status: 'active' });
  return member ? (await licenses.findOne({ org_id: member.org_id })) ?? undefined : undefined;
}

async function expireIfPastDeadline(key: string): Promise<void> {
  const now = new Date().toISOString();
  await mongoCollections.licenses.updateOne(
    { key, status: 'active', trial_ends_at: { $ne: null, $lt: now } },
    { $set: { status: 'expired', updated_at: now } },
  );
}

export async function lookupLicense(key: string): Promise<LicenseRecord | undefined> {
  const row = await findLicenseForKey(key);
  if (!row) return undefined;
  await expireIfPastDeadline(row.key);
  const refreshed = await mongoCollections.licenses.findOne({ id: row.id });
  return refreshed ? toRecord(refreshed) : undefined;
}

export async function userIdFromLicense(key: string): Promise<string | null> {
  const direct = await mongoCollections.licenses.findOne({ key });
  if (direct) return direct.user_id ?? null;
  const seat = await mongoCollections.organization_members.findOne({ license_key: key, status: 'active' });
  return seat?.user_id ?? null;
}

export async function getLicenseForUser(userId: string): Promise<LicenseWithKey | undefined> {
  const licenses = mongoCollections.licenses;
  const row = await licenses.findOne({ user_id: userId });
  if (!row) return undefined;
  await expireIfPastDeadline(row.key);
  const refreshed = await licenses.findOne({ id: row.id });
  return refreshed ? { ...toRecord(refreshed), key: refreshed.key } : undefined;
}

export async function hasHadTrial(userId: string): Promise<boolean> {
  return !!(await userService.findUserById(userId))?.trial_started_at;
}

export async function grantFreeTrial(userId: string): Promise<{ key: string; trialEndsAt: string } | { alreadyUsed: true }> {
  logDebug('Granting free trial license', { userId });
  const trialEndsAt = new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const key = `fk_live_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const outcome = await withTransaction(async (session) => {
    const users = mongoCollections.users;
    const result = await users.updateOne(
      { id: userId, trial_started_at: null },
      { $set: { trial_started_at: now, updated_at: now } },
      { session },
    );
    if (!result.modifiedCount) return false;
    await upsertUserLicense(userId, {
      key, plan: FREE_TRIAL_PLAN, quotaRemaining: FREE_TRIAL_QUOTA, trialEndsAt,
    }, session);
    return true;
  });
  if (!outcome) {
    logInfo('Free trial license not granted because the user already used a trial', { userId });
    return { alreadyUsed: true };
  }
  logInfo('Free trial license granted', { userId, plan: FREE_TRIAL_PLAN });
  return { key, trialEndsAt };
}

export async function reserveQuota(key: string): Promise<boolean> {
  const now = new Date().toISOString();
  const licenses = mongoCollections.licenses;
  const direct = await licenses.findOne({ key, status: 'active' });
  if (direct) {
    const result = await licenses.updateOne(
      { id: direct.id, status: 'active', quota_remaining: { $gt: 0 } },
      { $inc: { quota_remaining: -1 }, $set: { updated_at: now } },
    );
    if (result.modifiedCount) {
      logDebug('AI request quota reserved');
      return true;
    }
    logWarning('AI request quota reservation rejected because no active quota was available');
    return false;
  }
  const reserved = await withTransaction(async (session) => {
    const members = mongoCollections.organization_members;
    const member = await members.findOne({ license_key: key, status: 'active' }, { session });
    if (!member) return false;
    const result = await licenses.updateOne(
      { org_id: member.org_id, status: 'active', quota_remaining: { $gt: 0 } },
      { $inc: { quota_remaining: -1 }, $set: { updated_at: now } },
      { session },
    );
    if (!result.modifiedCount) return false;
    const attribution = await members.updateOne(
      { id: member.id, status: 'active' },
      { $inc: { calls_used: 1 }, $set: { updated_at: now } },
      { session },
    );
    if (!attribution.modifiedCount) throw new Error('Organization seat changed during quota reservation');
    return true;
  });
  if (!reserved) logWarning('AI request quota reservation rejected because no active quota was available');
  else logDebug('AI request quota reserved');
  return reserved;
}

export async function refundQuota(key: string): Promise<void> {
  const now = new Date().toISOString();
  const row = await findLicenseForKey(key);
  if (!row) return;
  await mongoCollections.licenses.updateOne(
    { id: row.id },
    { $inc: { quota_remaining: 1 }, $set: { updated_at: now } },
  );
  await mongoCollections.organization_members.updateOne(
    { license_key: key, status: 'active', calls_used: { $gt: 0 } },
    { $inc: { calls_used: -1 }, $set: { updated_at: now } },
  );
  logInfo('AI request quota reservation refunded');
}

export async function resetQuotaForSubscription(subscriptionId: string): Promise<void> {
  logDebug('Resetting license quota for billing cycle');
  const now = new Date().toISOString();
  const licenses = mongoCollections.licenses;
  const row = await licenses.findOne({ stripe_subscription_id: subscriptionId });
  if (!row) {
    logInfo('Billing-cycle quota reset skipped because no license matched');
    return;
  }
  if (row.org_id) {
    const org = await mongoCollections.organizations.findOne({ id: row.org_id });
    const granted = orgPoolSize(org?.seats_purchased ?? 0);
    await licenses.updateOne({ id: row.id }, { $set: { quota_granted: granted, quota_remaining: granted, updated_at: now } });
    logInfo('Organization license quota reset', { orgId: row.org_id, quotaGranted: granted });
  } else {
    await licenses.updateOne({ id: row.id }, [{ $set: { quota_remaining: '$quota_granted', updated_at: now } }]);
    logInfo('Individual license quota reset');
  }
}

async function upsertUserLicense(
  userId: string,
  opts: { key: string; plan: string; quotaRemaining: number; trialEndsAt?: string | null },
  session?: ClientSession,
): Promise<void> {
  const now = new Date().toISOString();
  await mongoCollections.licenses.updateOne(
    { user_id: userId },
    {
      $set: {
        key: opts.key, plan: opts.plan, status: 'active', quota_remaining: opts.quotaRemaining,
        quota_granted: opts.quotaRemaining, trial_ends_at: opts.trialEndsAt ?? null, updated_at: now,
      },
      $setOnInsert: { id: crypto.randomUUID(), user_id: userId, created_at: now },
    },
    { upsert: true, session },
  );
}

export async function createLicenseForUser(
  userId: string,
  opts: { plan: string; quotaRemaining: number; trialEndsAt?: string | null },
): Promise<string> {
  logDebug('Creating or replacing user license', { userId, plan: opts.plan });
  const key = `fk_live_${crypto.randomBytes(24).toString('hex')}`;
  await upsertUserLicense(userId, { ...opts, key });
  logInfo('User license created or replaced', { userId, plan: opts.plan, quotaGranted: opts.quotaRemaining });
  return key;
}

export async function createOrgPoolLicense(
  orgId: string,
  opts: {
    seats: number;
    customerId: string | null;
    subscriptionId: string | null;
    subscriptionItemId: string | null;
    currentPeriodEnd: string | null;
  },
): Promise<string> {
  logDebug('Creating or replacing organization pool license', { orgId, seats: opts.seats });
  const key = `fk_org_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const granted = orgPoolSize(opts.seats);
  await mongoCollections.licenses.updateOne(
    { org_id: orgId },
    {
      $set: {
        key, plan: TEAM_PLAN, status: 'active', quota_granted: granted, quota_remaining: granted,
        stripe_customer_id: opts.customerId, stripe_subscription_id: opts.subscriptionId,
        stripe_subscription_item_id: opts.subscriptionItemId, current_period_end: opts.currentPeriodEnd,
        updated_at: now,
      },
      $setOnInsert: { id: crypto.randomUUID(), org_id: orgId, user_id: null, created_at: now },
    },
    { upsert: true },
  );
  logInfo('Organization pool license created or replaced', { orgId, seats: opts.seats, quotaGranted: granted });
  return key;
}

export async function adjustOrgPoolForSeatChange(orgId: string, previousSeats: number, newSeats: number): Promise<void> {
  const delta = orgPoolSize(newSeats) - orgPoolSize(previousSeats);
  if (delta === 0) return;
  logDebug('Adjusting organization pool quota for seat change', { orgId, previousSeats, newSeats, quotaDelta: delta });
  const now = new Date().toISOString();
  await mongoCollections.licenses.updateOne(
    { org_id: orgId },
    [{ $set: {
      quota_granted: { $add: ['$quota_granted', delta] },
      quota_remaining: { $max: [{ $add: ['$quota_remaining', delta] }, 0] },
      updated_at: now,
    } }],
  );
  logInfo('Organization pool quota adjusted for seat change', { orgId, quotaDelta: delta });
}
