import 'dotenv/config';

/** parseInt returns NaN for a malformed value, which would otherwise travel all the way to
 * the payment provider as a plan amount or billing-cycle count. Money-path env vars use
 * this instead so a typo falls back to the default. */
function intEnv(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const port = parseInt(process.env.PORT ?? '4001', 10);
const publicUrl = process.env.RELAY_PUBLIC_URL ?? `http://localhost:${port}`;
const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  port,
  publicUrl,
  nodeEnv,
  isProduction: nodeEnv === 'production',

  mongodbUri: process.env.MONGODB_URI ?? '',
  mongodbDbName: process.env.MONGODB_DB_NAME ?? 'focuskube_relay',

  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'fk_session',
  sessionTtlDays: parseInt(process.env.SESSION_TTL_DAYS ?? '30', 10),
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),

  otpPepper: process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me',
  otpTtlMinutes: parseInt(process.env.OTP_TTL_MINUTES ?? '10', 10),
  smsOtpEnabled: process.env.SMS_OTP_ENABLED === 'true',

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

  brevo: {
    apiKey: process.env.BREVO_API_KEY ?? '',
  },

  smtp: {
    url: process.env.SMTP_URL ?? '',
    host: process.env.SMTP_HOST ?? '',
    port: intEnv(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
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

  // Which payment provider handles subscriptions on this deployment. Exactly one is active
  // at a time — see billing/provider.ts's activeProvider(). Stripe stays the default so an
  // existing deployment keeps working with no env change.
  billing: {
    provider: (process.env.BILLING_PROVIDER === 'razorpay' ? 'razorpay' : 'stripe') as 'stripe' | 'razorpay',
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    // The webhook signing secret from the Razorpay dashboard — NOT the API key secret above.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
    // Razorpay has no open-ended subscription: total_count (how many billing cycles to run)
    // is required at creation, so "forever" is expressed as ~100 years' worth of cycles.
    totalCountMonthly: intEnv(process.env.RAZORPAY_TOTAL_COUNT_MONTHLY, 1200),
    totalCountYearly: intEnv(process.env.RAZORPAY_TOTAL_COUNT_YEARLY, 100),
  },

  // The Pro plan's price and quota — used to build Stripe Checkout line items on the fly
  // (see billing/pricing.ts) rather than pointing at a pre-created Stripe Price object, so
  // changing a number here takes effect on the next checkout with no Stripe dashboard step.
  pricing: {
    proPriceMonthlyCents: parseInt(process.env.PRO_PRICE_MONTHLY_CENTS ?? '1999', 10),
    annualDiscountPercent: parseInt(process.env.PRO_ANNUAL_DISCOUNT_PERCENT ?? '10', 10),
    proQuota: parseInt(process.env.PRO_PLAN_QUOTA ?? '2000', 10),
    // Prices above are authored in USD. Razorpay bills in INR, so the INR amount is this
    // multiple of the USD figure ($19.99 -> ₹1999 at the default 100) rather than a live FX
    // rate: a Razorpay Plan's amount is immutable, so a drifting rate would mint a new plan
    // per change and leave customers on different prices. Bump this env to re-price.
    usdToInrRate: intEnv(process.env.USD_TO_INR_RATE, 100),
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
    // A separate embeddings-model deployment (e.g. text-embedding-3-small) in the SAME Azure
    // OpenAI resource — used only by the k8s-docs knowledge base (llm/embeddings.ts), never
    // by chat. Independent of `deployment`/`aiProvider`: embeddings still work here even if
    // AI_PROVIDER is 'anthropic' for chat, as long as apiKey/endpoint/this are set.
    embeddingsDeployment: process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT ?? '',
  },
};
