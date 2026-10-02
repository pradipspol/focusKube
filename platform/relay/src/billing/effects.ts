import crypto from 'node:crypto';
import type { Document } from 'mongodb';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { mongoCollections } from '../mongoCollections.js';
import { logDebug, logInfo } from '../logger.js';
import { adjustOrgPoolForSeatChange, createLicenseForUser, orgPoolSize, resetQuotaForSubscription } from '../licenseStore.js';
import { organizationService } from '../org/organizationService.js';

export type BillingProviderName = 'stripe' | 'razorpay';
const PAID_PLAN = 'pro';

export async function activateIndividualSubscription(args: {
  provider: BillingProviderName;
  userId: string;
  customerId: string | null;
  subscriptionId: string | null;
}): Promise<void> {
  logDebug('Activating individual billing subscription', { provider: args.provider, userId: args.userId, hasSubscription: !!args.subscriptionId });
  const licenses = mongoCollections.licenses;
  const existing = await licenses.findOne({ user_id: args.userId });
  const now = new Date().toISOString();
  if (args.subscriptionId && existing?.stripe_subscription_id === args.subscriptionId) {
    await licenses.updateOne({ user_id: args.userId }, { $set: { status: 'active', updated_at: now } });
    logInfo('Individual billing subscription reactivated', { provider: args.provider, userId: args.userId });
    return;
  }
  await createLicenseForUser(args.userId, { plan: PAID_PLAN, quotaRemaining: config.pricing.proQuota });
  await licenses.updateOne({ user_id: args.userId }, { $set: {
    stripe_customer_id: args.customerId, stripe_subscription_id: args.subscriptionId,
    billing_provider: args.provider, updated_at: now,
  } });
  logInfo('Individual billing subscription activated', { provider: args.provider, userId: args.userId });
}

export async function activateOrgSubscription(args: {
  provider: BillingProviderName;
  orgId: string;
  seats: number;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionItemId: string | null;
  currentPeriodEnd: string | null;
}): Promise<void> {
  logDebug('Activating organization billing subscription', { provider: args.provider, orgId: args.orgId, seats: args.seats });
  const org = await organizationService.findOrgById(args.orgId);
  if (!org) {
    logInfo('Organization billing activation skipped because the organization does not exist', { orgId: args.orgId });
    return;
  }
  const existingPool = await mongoCollections.licenses.findOne({ org_id: args.orgId });
  const now = new Date().toISOString();
  if (args.subscriptionId && existingPool?.stripe_subscription_id === args.subscriptionId) {
    await withTransaction(async (session) => {
      await mongoCollections.licenses.updateOne({ org_id: args.orgId }, { $set: { status: 'active', updated_at: now } }, { session });
      await mongoCollections.organizations.updateOne({ id: org.id }, { $set: { status: 'active', updated_at: now } }, { session });
    });
    logInfo('Organization billing subscription reactivated', { provider: args.provider, orgId: args.orgId });
    return;
  }

  const key = `fk_org_${crypto.randomBytes(24).toString('hex')}`;
  const granted = orgPoolSize(args.seats);
  const memberKey = `fk_seat_${crypto.randomBytes(24).toString('hex')}`;
  await withTransaction(async (session) => {
    await mongoCollections.organizations.updateOne({ id: org.id }, { $set: {
      status: 'active', seats_purchased: args.seats, updated_at: now,
    } }, { session });
    await mongoCollections.licenses.updateOne({ org_id: org.id }, {
      $set: {
        key, plan: 'team', status: 'active', quota_granted: granted, quota_remaining: granted,
        stripe_customer_id: args.customerId, stripe_subscription_id: args.subscriptionId,
        stripe_subscription_item_id: args.subscriptionItemId, current_period_end: args.currentPeriodEnd,
        billing_provider: args.provider, updated_at: now,
      },
      $setOnInsert: { id: crypto.randomUUID(), org_id: org.id, user_id: null, created_at: now },
    }, { upsert: true, session });
    await mongoCollections.organization_members.updateOne({ org_id: org.id, user_id: org.owner_user_id }, {
      $set: {
        role: 'owner', status: 'active', license_key: memberKey, invited_by_user_id: null,
        joined_at: now, removed_at: null, updated_at: now,
      },
      $setOnInsert: { id: crypto.randomUUID(), org_id: org.id, user_id: org.owner_user_id, calls_used: 0, created_at: now },
    }, { upsert: true, session });
  });
  logInfo('Organization billing subscription activated', { provider: args.provider, orgId: args.orgId, seats: args.seats });
}

export async function setSubscriptionStatus(subscriptionId: string, status: 'active' | 'inactive'): Promise<void> {
  logDebug('Updating billing subscription status', { status });
  const org = await organizationService.findOrgBySubscriptionId(subscriptionId);
  await mongoCollections.licenses.updateOne({ stripe_subscription_id: subscriptionId }, {
    $set: { status, updated_at: new Date().toISOString() },
  });
  if (org) await organizationService.setOrgStatus(org.id, status);
  logInfo('Billing subscription status updated', { status, organizationSubscription: !!org });
}

export async function syncSeatsForSubscription(subscriptionId: string, seats: number | null | undefined): Promise<void> {
  const org = await organizationService.findOrgBySubscriptionId(subscriptionId);
  if (!org) {
    logDebug('Billing seat synchronization skipped for an individual subscription');
    return;
  }
  const newSeats = seats ?? org.seats_purchased;
  if (newSeats === org.seats_purchased) {
    logDebug('Billing seat synchronization found no change', { orgId: org.id, seats: newSeats });
    return;
  }
  logDebug('Synchronizing organization seats from billing provider', { orgId: org.id, seats: newSeats });
  await adjustOrgPoolForSeatChange(org.id, org.seats_purchased, newSeats);
  await organizationService.setOrgSeatsPurchased(org.id, newSeats);
  logInfo('Organization seats synchronized from billing provider', { orgId: org.id, seats: newSeats });
}

export async function endSubscription(subscriptionId: string): Promise<void> {
  logDebug('Ending billing subscription');
  const org = await organizationService.findOrgBySubscriptionId(subscriptionId);
  await mongoCollections.licenses.updateMany({ stripe_subscription_id: subscriptionId }, {
    $set: { status: 'inactive', stripe_subscription_id: null, updated_at: new Date().toISOString() },
  });
  if (org) await organizationService.setOrgStatus(org.id, 'cancelled');
  logInfo('Billing subscription ended', { organizationSubscription: !!org, orgId: org?.id ?? null });
}

export async function renewSubscriptionQuota(subscriptionId: string): Promise<void> {
  logDebug('Renewing billing subscription quota');
  await resetQuotaForSubscription(subscriptionId);
  logInfo('Billing subscription quota renewal completed');
}

export async function claimBillingEvent(provider: BillingProviderName, eventId: string): Promise<boolean> {
  logDebug('Claiming billing webhook event', { provider });
  const id = `${provider}:${eventId}`;
  const events = mongoCollections.billing_events;
  if (await events.findOne({ id })) {
    logInfo('Duplicate billing webhook event detected', { provider });
    return false;
  }
  if (provider === 'stripe' && await mongoCollections.stripe_events.findOne({ id: eventId })) {
    logInfo('Previously processed Stripe webhook event detected', { provider });
    return false;
  }
  try {
    await events.insertOne({ id, provider, processed_at: new Date().toISOString() });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return false;
    throw error;
  }
  logInfo('Billing webhook event claimed', { provider });
  return true;
}

export async function releaseBillingEvent(provider: BillingProviderName, eventId: string): Promise<void> {
  logDebug('Releasing billing webhook event claim', { provider });
  await mongoCollections.billing_events.deleteOne({ id: `${provider}:${eventId}` });
  logInfo('Billing webhook event claim released', { provider });
}
