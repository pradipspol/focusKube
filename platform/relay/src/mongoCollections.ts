import type { Db, Document } from 'mongodb';
import type { UserRow } from './auth/users.js';
import type { OtpRow } from './auth/otp.js';
import type { SessionRow } from './auth/sessions.js';
import type { LicenseRow } from './licenseStore.js';
import type { OrganizationInviteRow, OrganizationMemberRow, OrganizationRow } from './org/store.js';
import { MongoDBService, type MongoIndexDefinition } from './mongoService.js';

export interface MongoCollectionService {
  initialize(database: Db): Promise<string[]>;
}

export interface TokenMongoDocument extends Document {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
}

export interface BillingEventMongoDocument extends Document {
  id: string;
  provider?: string;
  processed_at?: string;
}

export interface RazorpayPlanMongoDocument extends Document {
  plan_key: string;
  plan_id: string;
  created_at: string;
}

export interface RazorpayCheckoutMongoDocument extends Document {
  subscription_id: string;
  user_id: string;
}

export interface DocChunkMongoDocument extends Document {
  id: string;
  url: string;
  content_hash: string;
  title: string;
  heading: string | null;
  content: string;
  embedding: number[] | string;
  index?: number;
  source?: string;
  updated_at?: string;
}

export class UsersMongoService extends MongoDBService<UserRow> {
  protected readonly collectionName = 'users';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { email: 1 }, options: { unique: true, partialFilterExpression: { email: { $type: 'string' } } } },
    { keys: { phone: 1 }, options: { unique: true, partialFilterExpression: { phone: { $type: 'string' } } } },
    { keys: { google_sub: 1 }, options: { unique: true, partialFilterExpression: { google_sub: { $type: 'string' } } } },
  ];
}

export class SessionsMongoService extends MongoDBService<SessionRow> {
  protected readonly collectionName = 'sessions';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { token_hash: 1 }, options: { unique: true } }, { keys: { user_id: 1 } },
  ];
}

export class OtpCodesMongoService extends MongoDBService<OtpRow> {
  protected readonly collectionName = 'otp_codes';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { destination: 1, purpose: 1, created_at: -1 } },
    { keys: { destination: 1, purpose: 1 }, options: { unique: true, partialFilterExpression: { consumed_at: null } } },
  ];
}

export class PasswordResetTokensMongoService extends MongoDBService<TokenMongoDocument> {
  protected readonly collectionName = 'password_reset_tokens';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { token_hash: 1 }, options: { unique: true } }];
}

export class OAuthHandoffsMongoService extends MongoDBService<TokenMongoDocument> {
  protected readonly collectionName = 'oauth_handoffs';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { token_hash: 1 }, options: { unique: true } }];
}

export class LicensesMongoService extends MongoDBService<LicenseRow> {
  protected readonly collectionName = 'licenses';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { key: 1 }, options: { unique: true } },
    { keys: { user_id: 1 }, options: { unique: true, partialFilterExpression: { user_id: { $type: 'string' } } } },
    { keys: { org_id: 1 }, options: { unique: true, partialFilterExpression: { org_id: { $type: 'string' } } } },
    { keys: { stripe_subscription_id: 1 }, options: { sparse: true } },
  ];
}

export class BillingEventsMongoService extends MongoDBService<BillingEventMongoDocument> {
  protected readonly collectionName = 'billing_events';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { id: 1 }, options: { unique: true } }];
}

export class StripeEventsMongoService extends MongoDBService<BillingEventMongoDocument> {
  protected readonly collectionName = 'stripe_events';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { id: 1 }, options: { unique: true } }];
}

export class RazorpayPlansMongoService extends MongoDBService<RazorpayPlanMongoDocument> {
  protected readonly collectionName = 'razorpay_plans';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { plan_key: 1 }, options: { unique: true } }];
}

export class RazorpayCheckoutsMongoService extends MongoDBService<RazorpayCheckoutMongoDocument> {
  protected readonly collectionName = 'razorpay_checkouts';
  protected readonly indexes: MongoIndexDefinition[] = [{ keys: { subscription_id: 1 }, options: { unique: true } }];
}

export class OrganizationsMongoService extends MongoDBService<OrganizationRow> {
  protected readonly collectionName = 'organizations';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { owner_user_id: 1 }, options: { unique: true } },
  ];
}

export class OrganizationMembersMongoService extends MongoDBService<OrganizationMemberRow> {
  protected readonly collectionName = 'organization_members';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { org_id: 1, user_id: 1 }, options: { unique: true } },
    { keys: { license_key: 1 }, options: { unique: true } },
    { keys: { user_id: 1 }, options: { unique: true, partialFilterExpression: { status: 'active' } } },
  ];
}

export class OrganizationInvitesMongoService extends MongoDBService<OrganizationInviteRow> {
  protected readonly collectionName = 'organization_invites';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } },
    { keys: { token_hash: 1 }, options: { unique: true } },
    { keys: { org_id: 1, email: 1 }, options: { unique: true, partialFilterExpression: { status: 'pending' } } },
    { keys: { org_id: 1, status: 1, expires_at: 1 } },
  ];
}

export class DocChunksMongoService extends MongoDBService<DocChunkMongoDocument> {
  protected readonly collectionName = 'doc_chunks';
  protected readonly indexes: MongoIndexDefinition[] = [
    { keys: { id: 1 }, options: { unique: true } }, { keys: { url: 1 } },
  ];
}

export const mongoCollections = {
  users: new UsersMongoService(),
  sessions: new SessionsMongoService(),
  otp_codes: new OtpCodesMongoService(),
  password_reset_tokens: new PasswordResetTokensMongoService(),
  oauth_handoffs: new OAuthHandoffsMongoService(),
  licenses: new LicensesMongoService(),
  billing_events: new BillingEventsMongoService(),
  stripe_events: new StripeEventsMongoService(),
  razorpay_plans: new RazorpayPlansMongoService(),
  razorpay_checkouts: new RazorpayCheckoutsMongoService(),
  organizations: new OrganizationsMongoService(),
  organization_members: new OrganizationMembersMongoService(),
  organization_invites: new OrganizationInvitesMongoService(),
  doc_chunks: new DocChunksMongoService(),
} satisfies Record<string, MongoCollectionService>;

export type MongoCollectionName = keyof typeof mongoCollections;

export function getMongoCollectionService<T extends MongoCollectionName>(name: T): (typeof mongoCollections)[T] {
  const service = mongoCollections[name];
  if (!service) throw new Error(`MongoDB collection service '${name}' is not registered`);
  return service;
}