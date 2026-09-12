import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Plain CREATE TABLE IF NOT EXISTS — no migration framework needed at this scale.
// Every timestamp is an ISO string; every id a crypto.randomUUID().
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    trial_started_at TEXT,
    first_name TEXT,
    last_name TEXT,
    company TEXT,
    avatar_data_url TEXT,
    product_updates_opt_in INTEGER NOT NULL DEFAULT 1,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    channel TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_otp_destination ON otp_codes(destination, purpose);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  -- Short-lived, single-use codes that hand a session off to a self-hosted focusKube
  -- backend after an app-initiated Google OAuth flow, without ever putting the real
  -- session token in a URL/browser history (see auth/routes.ts's /google/callback and
  -- /session/exchange).
  CREATE TABLE IF NOT EXISTS oauth_handoffs (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  -- License keys stay plaintext at rest (unlike sessions/OTP codes): the dashboard
  -- needs to re-display a customer's key indefinitely, the way a product key or API
  -- key is normally re-viewable in an account portal — this isn't a one-time-reveal secret.
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    quota_remaining INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    trial_ends_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  );

  -- Team (multi-seat) licensing. An org's pooled credit balance lives as a row in
  -- the licenses table itself (org_id set, user_id NULL — already legal today, see
  -- seedDevLicenseIfEmpty's NULL user_id row), not a separate table, so the existing
  -- customer.subscription.updated/.deleted webhook handlers (keyed by stripe_subscription_id
  -- alone) already flip a Team pool's status correctly with no extra branching. An org is
  -- created (status 'pending') at checkout time and activated by the webhook.
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL,                       -- 'pending' | 'active' | 'inactive' | 'cancelled'
    seats_purchased INTEGER NOT NULL DEFAULT 0, -- mirrors the Stripe subscription item quantity
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_org_owner ON organizations(owner_user_id);

  -- One row per seat. license_key is this member's OWN credential (fk_seat_<hex>) — not a
  -- row in the licenses table, since licenses.user_id is UNIQUE and a member may also hold
  -- a personal license. Removing a member revokes exactly this one key immediately, without
  -- disturbing any other member's cached key (see licenseStore.ts's lookupLicense).
  CREATE TABLE IF NOT EXISTS organization_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                         -- 'owner' | 'member'
    status TEXT NOT NULL,                       -- 'active' | 'removed'
    license_key TEXT UNIQUE NOT NULL,
    calls_used INTEGER NOT NULL DEFAULT 0,
    invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    joined_at TEXT NOT NULL,
    removed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_org_member_unique ON organization_members(org_id, user_id);
  -- At most one active seat per user, anywhere — keeps entitlement resolution a single
  -- unambiguous row instead of a "which of my orgs?" choice.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_org_member_active_user
    ON organization_members(user_id) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_org_member_org ON organization_members(org_id, status);

  -- Same "random token, store only its sha256, look up by hash" shape as
  -- password_reset_tokens / oauth_handoffs above.
  CREATE TABLE IF NOT EXISTS organization_invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,                        -- normalized lowercase
    token_hash TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,                       -- 'pending' | 'accepted' | 'revoked' | 'expired'
    invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT
  );
  -- At most one live invite per address per org; a "resend" rotates the token in place.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invite_pending
    ON organization_invites(org_id, email) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_org_invite_org ON organization_invites(org_id, status);
`);

// CREATE TABLE IF NOT EXISTS only creates missing tables, not missing columns on tables
// that already existed before this change — this guard makes an older on-disk relay.db
// pick up new columns instead of every query against them throwing "no such column".
function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('users', 'display_name', 'display_name TEXT');
ensureColumn('users', 'trial_started_at', 'trial_started_at TEXT');
ensureColumn('users', 'first_name', 'first_name TEXT');
ensureColumn('users', 'last_name', 'last_name TEXT');
ensureColumn('users', 'company', 'company TEXT');
ensureColumn('users', 'avatar_data_url', 'avatar_data_url TEXT');
ensureColumn('users', 'product_updates_opt_in', 'product_updates_opt_in INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'two_factor_enabled', 'two_factor_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'deleted_at', 'deleted_at TEXT');
ensureColumn('licenses', 'trial_ends_at', 'trial_ends_at TEXT');

// Team seats: a license row now optionally belongs to an org instead of a user (see the
// organizations/organization_members tables above). Invariant, enforced in code rather than
// a DB constraint (SQLite can't add a CHECK to an existing table without a full rebuild):
// every licenses row has at most one of user_id / org_id set.
ensureColumn('licenses', 'org_id', 'org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE');
// The target quota_remaining resets to at the start of each billing cycle (see
// licenseStore.ts's resetQuotaForSubscription) — previously licenses never refilled once
// granted, so this also backfills existing rows below.
ensureColumn('licenses', 'quota_granted', 'quota_granted INTEGER NOT NULL DEFAULT 0');
// Needed to change seat count later — Stripe sets subscription quantity on the item, not
// the subscription itself (org/billing.ts's updateOrgSeats).
ensureColumn('licenses', 'stripe_subscription_item_id', 'stripe_subscription_item_id TEXT');
ensureColumn('licenses', 'current_period_end', 'current_period_end TEXT');

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_org ON licenses(org_id) WHERE org_id IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_subscription ON licenses(stripe_subscription_id)`);

db.prepare(
  `UPDATE licenses SET quota_granted = quota_remaining WHERE quota_granted = 0 AND quota_remaining > 0`,
).run();
