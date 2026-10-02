# focusKube AI relay

Vendor-hosted service behind the focusKube AI assistant. This is the **only** place the real
Anthropic API key is allowed to live — `platform/backend` is self-hosted by users (including
on air-gapped networks), so it never holds the key; it only calls out to this relay over a
license key. This service also owns customer accounts, sign-in, and license issuance — a
customer signs up here, subscribes through the configured billing provider, and gets a
license key to paste into focusKube.

## Running locally

```bash
cd platform/relay
npm ci
cp .env.example .env   # set MONGODB_URI and the credentials you need
npm run dev
```

The relay connects to MongoDB Atlas using `MONGODB_URI` and `MONGODB_DB_NAME` (default
`focuskube_relay`). It creates the required collections/indexes on startup. Configure the
Atlas network access list and a database user with read/write access to this database. Never
commit the URI or its password. If the `licenses` collection is empty, a dev license key is
seeded (default `fk_dev_local_testing`, override via `AI_RELAY_DEV_LICENSE_KEY`) so
`platform/backend` can be pointed at this relay without signup/billing first.

Point the backend at it (already the default):

```bash
cd platform/backend
AI_RELAY_BASE_URL=http://localhost:4001 npm run dev
```

## Running in Docker

```bash
cd platform/relay
docker build -t focuskube-relay .
docker run -p 4001:4001 --env-file .env focuskube-relay
```

The image is a multi-stage build (compile with devDependencies, then a slim
`node:24-alpine` runtime with only production dependencies) and runs as a non-root user.
Database persistence is handled by Atlas, not a container volume. Supply `MONGODB_URI` and
`MONGODB_DB_NAME` plus `ANTHROPIC_API_KEY` (or the Azure OpenAI equivalent) through the
environment; secrets are not baked into the image.

### What needs real credentials vs. what works out of the box

Email/password sign-up, sessions, the account dashboard, and email-OTP sign-in use Atlas.
Password-reset and OTP emails are skipped when neither Brevo API nor SMTP is configured; no OTP code is logged.
SMS OTP is disabled by default; set `SMS_OTP_ENABLED=true` and configure Twilio to enable it.
Google sign-in and the selected billing provider need real credentials to exercise end-to-end.
See `.env.example` for the environment variables.

### Brevo API for email OTP

The relay prefers Brevo's transactional email HTTPS API when `BREVO_API_KEY` is set. Create
an API key in Brevo, verify the sender address or domain used by `EMAIL_FROM`, and configure
these in `platform/relay/.env`:

```env
BREVO_API_KEY=YOUR_BREVO_API_KEY
EMAIL_FROM="focusKube <no-reply@your-verified-domain.example>"
```

The existing SMTP transporter remains available as a fallback when `BREVO_API_KEY` is blank.
For Brevo SMTP fallback, use its SMTP login and SMTP key (not the API key), set
`SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, and `SMTP_SECURE=false`. `SMTP_URL` remains
supported when `SMTP_HOST` is blank. Keep all keys private and never commit `.env`. Restart
the relay, open
`http://localhost:4001/otp`, and request a code for an inbox you can access.

## Web pages (customer-facing)

`/signup`, `/login`, `/otp`, `/forgot-password`, `/reset-password`, `/dashboard` — plain
server-rendered HTML with vanilla JS calling the JSON API below. No build step, no framework:
proportionate to this service's current scope, and deliberately not the React app in
`platform/frontend` (that's a different product surface for a different audience).

## API

**Auth**
- `POST /v1/auth/signup` — `{email, password, firstName?, lastName?}` → emails a verification code; no account or session is created yet.
- `POST /v1/auth/signup/verify` — `{email, password, code, firstName?, lastName?}` → verifies the email, creates the account, and sets an httpOnly session cookie.
- `POST /v1/auth/login` — `{email, password}` → sets an httpOnly session cookie for an existing account.
- `POST /v1/auth/otp/request` — `{destination, channel: "email"|"sms"}` → emails/texts a 6-digit code. Email requires `BREVO_API_KEY` or SMTP settings for delivery; SMS is rejected unless `SMS_OTP_ENABLED=true`.
- `POST /v1/auth/otp/verify` — `{destination, channel, code}` → finds-or-creates the account and signs in.
- `GET /v1/auth/google/start` / `GET /v1/auth/google/callback` — Google OAuth (needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; 503s otherwise).
- `POST /v1/auth/logout` — clears the session.
- `GET /v1/auth/me` — current user (session-protected).
- `POST /v1/auth/password/reset-request` / `/reset-confirm` — email-token based password reset.

**Account**
- `GET /v1/account` — profile + license/subscription status (session-protected).
- `POST /v1/account/license/regenerate` — rotates the user's key without changing its billing linkage.

**Billing** (select with `BILLING_PROVIDER`; the example environment selects Razorpay)
- `POST /v1/billing/checkout` — creates a checkout with the configured provider (session-protected, requires a verified email).
- `POST /v1/billing/portal` — creates a customer portal session when supported by the configured provider.
- `POST /v1/billing/webhook` — verifies provider webhook signatures and applies subscription changes idempotently. For Razorpay, configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.

**Relay proper** (used by `platform/backend`, not the web UI)
- `POST /v1/license/validate` — `Authorization: Bearer <key>` → `{plan, status, quotaRemaining}` or 401/403.
- `POST /v1/ai/chat` — `Authorization: Bearer <key>` + `{context, messages, model?, maxTokens?}`, streams back `data: {"type":"token"|"tool_use"|"error", ...}` lines terminated by `data: [DONE]`. A reduced protocol tailored to `platform/backend/src/services/aiService.ts`, not raw Anthropic SSE.

## Data

Application state is stored in MongoDB Atlas collections; startup creates the indexes used for
identity uniqueness, sessions, licenses, billing-event idempotency, team seats/invites, and
documentation chunks. Multi-document billing activation and invite acceptance use Atlas
transactions. Session tokens, OTP codes, and password-reset tokens are hashed at rest; license
keys are stored plaintext because a customer needs to re-view their key in the dashboard.
Existing records in an old `relay.db` SQLite file are not imported automatically; export/import
those records before switching a deployment that contains customer data.

### MongoDB services

Relay collection services extend `MongoDBService<T>` from `src/mongoService.ts`. The base
class owns collection access and common insert, query, update, delete, count, aggregate, and
bulk-write operations. Collection subclasses declare their document type, collection name,
and indexes in `src/mongoCollections.ts`; add new services to the registry there so indexes
are created before the server starts. Put domain rules in the relevant service/store, and use
the inherited methods for database operations rather than accessing the MongoDB driver
directly.

For domain workflows, prefer injectable service classes when operations share behavior or
dependencies. `UserService` in `src/auth/users.ts` and `OrganizationService` in
`src/org/store.ts` receive narrow repository interfaces; `src/auth/userService.ts` and
`src/org/organizationService.ts` compose their production instances. Tests can provide fake
repositories without importing MongoDB. Keep simple stateless helpers as functions; do not
create a class solely to wrap a single function.

## Security notes

- Sessions are opaque, DB-backed tokens (not JWTs) in an httpOnly, `SameSite=Lax` cookie —
  looked up per request, same "opaque key, DB lookup" philosophy already used for license keys.
- CSRF: relying on `SameSite=Lax` + JSON-only endpoints as sufficient v1 mitigation rather than a
  separate CSRF-token system — a deliberate scope call.
- Google account linking only attaches to an *existing* account when Google's own
  `email_verified` claim is true, to prevent an unverified Google email from hijacking someone
  else's account.
- OTP codes are peppered+hashed, rate-limited per destination (not just per-IP), and requesting a
  new code invalidates any still-pending one for that destination.
- Billing webhook handling is idempotent per provider event id (`billing_events` collection)
  since providers may redeliver after timeouts or retries.
