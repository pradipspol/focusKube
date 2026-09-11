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
  },
};
