import 'dotenv/config';
import path from 'node:path';

const publicUrl = process.env.RELAY_PUBLIC_URL ?? 'http://localhost:4001';
const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  port: parseInt(process.env.PORT ?? '4001', 10),
  publicUrl,
  nodeEnv,
  isProduction: nodeEnv === 'production',

  dbPath: process.env.RELAY_DB_PATH ?? path.join(process.cwd(), 'data', 'relay.db'),

  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'fk_session',
  sessionTtlDays: parseInt(process.env.SESSION_TTL_DAYS ?? '30', 10),

  otpPepper: process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me',
  otpTtlMinutes: parseInt(process.env.OTP_TTL_MINUTES ?? '10', 10),

  passwordResetTtlMinutes: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? '30', 10),

  devLicenseKey: process.env.AI_RELAY_DEV_LICENSE_KEY ?? 'fk_dev_local_testing',

  // "<owner>/<repo>" the /download page links to (GitHub Releases) — see
  // .github/workflows/publish-release.yml, which publishes signed win/mac/linux
  // installers there on every release.
  githubRepo: process.env.GITHUB_REPO ?? 'pradipspol/focusKube',

  // Non-loopback origins a self-hosted focusKube backend is allowed to ask the Google OAuth
  // flow to hand control back to (see auth/routes.ts's `app_redirect` handling) — e.g. a
  // team's real self-hosted domain. Any http://localhost or http://127.0.0.1 origin (any
  // port) is always allowed regardless of this list, since only local software can bind a
  // loopback port on the user's own machine.
  allowedAppRedirects: (process.env.ALLOWED_APP_REDIRECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? `${publicUrl}/v1/auth/google/callback`,
  },

  smtp: {
    url: process.env.SMTP_URL ?? '',
    from: process.env.EMAIL_FROM ?? 'focusKube <no-reply@focuskube.dev>',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? '',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    priceId: process.env.STRIPE_PRICE_ID ?? '',
    // Dev mode: simulate Stripe checkout/webhooks without real Stripe API keys.
    // Set STRIPE_DEMO_MODE=true to enable (auto-enabled when secretKey is empty in dev).
    demoMode: process.env.STRIPE_DEMO_MODE === 'true' || (!process.env.STRIPE_SECRET_KEY && nodeEnv === 'development'),
  },

  // The Pro plan's price and quota — used to build Stripe Checkout line items on the fly
  // (see billing/pricing.ts) rather than pointing at a pre-created Stripe Price object, so
  // changing a number here takes effect on the next checkout with no Stripe dashboard step.
  pricing: {
    proPriceMonthlyCents: parseInt(process.env.PRO_PRICE_MONTHLY_CENTS ?? '1999', 10),
    annualDiscountPercent: parseInt(process.env.PRO_ANNUAL_DISCOUNT_PERCENT ?? '10', 10),
    proQuota: parseInt(process.env.PRO_PLAN_QUOTA ?? '2000', 10),
  },

  // Team (multi-seat) licensing — an org owner buys N Pro seats and invites teammates by
  // email to draw on one pooled credit balance (see org/*.ts).
  org: {
    minSeats: parseInt(process.env.ORG_MIN_SEATS ?? '2', 10),
    maxSeats: parseInt(process.env.ORG_MAX_SEATS ?? '100', 10),
    // Defaults to the same per-seat quota as an individual Pro license (env-var default
    // can't reference config.pricing.proQuota directly, since this literal object hasn't
    // finished evaluating yet — kept in sync as *defaults* only; each is independently
    // configurable via its own env var).
    poolQuotaPerSeat: parseInt(process.env.ORG_POOL_QUOTA_PER_SEAT ?? process.env.PRO_PLAN_QUOTA ?? '2000', 10),
    inviteTtlDays: parseInt(process.env.ORG_INVITE_TTL_DAYS ?? '14', 10),
    maxInvitesPerHour: parseInt(process.env.ORG_MAX_INVITES_PER_HOUR ?? '20', 10),
  },

  // Which LLM backs /v1/ai/chat (see llm/chatProvider.ts). 'anthropic' (default) talks to
  // Anthropic directly; 'azure-openai' talks to an Azure OpenAI deployment instead. Either
  // way, /v1/ai/chat's wire protocol to platform/backend is unchanged — only which model
  // actually answers changes.
  aiProvider: (process.env.AI_PROVIDER === 'azure-openai' ? 'azure-openai' : 'anthropic') as
    | 'anthropic'
    | 'azure-openai',

  azureOpenai: {
    apiKey: process.env.AZURE_OPENAI_API_KEY ?? '',
    // e.g. https://<resource>.openai.azure.com — chatProvider.ts appends /openai/v1/ itself.
    endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? '',
    // Azure addresses models by deployment name, not the underlying model name.
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? '',
  },
};
