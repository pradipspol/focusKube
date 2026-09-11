# focusKube AI relay

Vendor-hosted service behind the focusKube AI assistant. This is the **only** place the real
Anthropic API key is allowed to live — `platform/backend` is self-hosted by users (including
on air-gapped networks), so it never holds the key; it only calls out to this relay over a
license key. This service also owns customer accounts, sign-in, and license issuance — a
customer signs up here, subscribes via Stripe, and gets a license key to paste into focusKube.

## Running locally

```bash
cd platform/relay
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
npm run dev
```

A SQLite DB is created automatically at `./data/relay.db` (gitignored). If the `licenses`
table is empty, a dev license key is auto-seeded (default `fk_dev_local_testing`, override via
`AI_RELAY_DEV_LICENSE_KEY`) so `platform/backend` can be pointed at this relay without going
through signup/billing first.

Point the backend at it (already the default):

```bash
cd platform/backend
AI_RELAY_BASE_URL=http://localhost:4001 npm run dev
```

### What needs real credentials vs. what works out of the box

Email/password sign-up, sessions, the account dashboard, and email-OTP sign-in all work with
**zero external credentials** in dev — SQLite is local, sessions are self-contained, and
password-reset/OTP emails log to the console instead of sending when `SMTP_URL` isn't set (same
for SMS OTP when Twilio credentials aren't set). Google sign-in and Stripe billing genuinely
need real accounts to exercise end-to-end — see `.env.example` for the full list of environment
variables and where to obtain each credential.

## Web pages (customer-facing)

`/signup`, `/login`, `/otp`, `/forgot-password`, `/reset-password`, `/dashboard` — plain
server-rendered HTML with vanilla JS calling the JSON API below. No build step, no framework:
proportionate to this service's current scope, and deliberately not the React app in
`platform/frontend` (that's a different product surface for a different audience).

## API

**Auth**
- `POST /v1/auth/signup` / `/login` — `{email, password}` → sets an httpOnly session cookie.
- `POST /v1/auth/otp/request` — `{destination, channel: "email"|"sms"}` → emails/texts a 6-digit code (console-logged in dev without SMTP/Twilio configured).
- `POST /v1/auth/otp/verify` — `{destination, channel, code}` → finds-or-creates the account and signs in.
- `GET /v1/auth/google/start` / `GET /v1/auth/google/callback` — Google OAuth (needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; 503s otherwise).
- `POST /v1/auth/logout` — clears the session.
- `GET /v1/auth/me` — current user (session-protected).
- `POST /v1/auth/password/reset-request` / `/reset-confirm` — email-token based password reset.

**Account**
- `GET /v1/account` — profile + license/subscription status (session-protected).
- `POST /v1/account/license/regenerate` — rotates the user's key without touching plan/Stripe linkage.

**Billing** (needs `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID`; 503s otherwise)
- `POST /v1/billing/checkout` — creates a Stripe Checkout session (session-protected, requires a verified email).
- `POST /v1/billing/portal` — creates a Stripe customer billing-portal session.
- `POST /v1/billing/webhook` — Stripe webhook (signature-verified, idempotent by event id): `checkout.session.completed` issues the user's license, `customer.subscription.updated`/`.deleted` sync its status.

**Relay proper** (used by `platform/backend`, not the web UI)
- `POST /v1/license/validate` — `Authorization: Bearer <key>` → `{plan, status, quotaRemaining}` or 401/403.
- `POST /v1/ai/chat` — `Authorization: Bearer <key>` + `{context, messages, model?, maxTokens?}`, streams back `data: {"type":"token"|"tool_use"|"error", ...}` lines terminated by `data: [DONE]`. A reduced protocol tailored to `platform/backend/src/services/aiService.ts`, not raw Anthropic SSE.

## Data

Everything lives in one SQLite file (`db.ts`), created with plain `CREATE TABLE IF NOT EXISTS`
statements at startup — no migration framework at this scale. Session tokens, OTP codes, and
password-reset tokens are hashed at rest; license keys are stored plaintext, since a customer
needs to re-view their key in the dashboard indefinitely (it's a re-viewable credential like a
product key, not a one-time-reveal secret).

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
- Stripe webhook handling is idempotent per event id (`stripe_events` table) since Stripe
  redelivers on timeout/retry.
