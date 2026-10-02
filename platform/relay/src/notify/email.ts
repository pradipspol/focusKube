import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logDebug, logError, logInfo } from '../logger.js';

let transporter: Transporter | null = null;
const BREVO_EMAIL_API_URL = 'https://api.brevo.com/v3/smtp/email';

function getTransporter(): Transporter | null {
  if (!config.smtp.host && !config.smtp.url) return null;
  if (!transporter) {
    if (config.smtp.host) {
      transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        ...(config.smtp.user || config.smtp.pass
          ? { auth: { user: config.smtp.user, pass: config.smtp.pass } }
          : {}),
      });
    } else {
      transporter = nodemailer.createTransport(config.smtp.url);
    }
  }
  return transporter;
}

function brevoSender(): { email: string; name?: string } {
  const match = config.smtp.from.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (!match) return { email: config.smtp.from.trim() };
  const name = match[1].replace(/^['"]|['"]$/g, '').trim();
  return { email: match[2].trim(), ...(name ? { name } : {}) };
}

async function sendWithBrevoApi(to: string, subject: string, text: string): Promise<void> {
  const response = await fetch(BREVO_EMAIL_API_URL, {
    method: 'POST',
    headers: {
      'api-key': config.brevo.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: brevoSender(),
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Brevo email API returned HTTP ${response.status}`);
  }
}

async function sendEmail(
  to: string,
  subject: string,
  text: string,
  messageType: 'password-reset' | 'otp' | 'organization-invite',
): Promise<void> {
  const useBrevoApi = Boolean(config.brevo.apiKey);
  const t = useBrevoApi ? null : getTransporter();
  if (!useBrevoApi && !t) {
    // No email provider configured — local auth flows remain usable without delivery.
    logInfo('Email delivery skipped because SMTP is not configured', { messageType });
    return;
  }
  const startedAt = Date.now();
  logDebug('Email delivery started', { messageType });
  try {
    if (useBrevoApi) {
      await sendWithBrevoApi(to, subject, text);
    } else {
      await t!.sendMail({ from: config.smtp.from, to, subject, text });
    }
    logInfo('Email delivery completed', { messageType, durationMs: Date.now() - startedAt });
  } catch (error) {
    logError('Email delivery failed', error, { messageType, durationMs: Date.now() - startedAt });
    throw error;
  }
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail(
    to,
    'Reset your focusKube password',
    `Reset your password: ${link}\n\nThis link expires in ${config.passwordResetTtlMinutes} minutes. If you didn't request this, ignore this email.`,
    'password-reset',
  );
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  await sendEmail(
    to,
    'Your focusKube sign-in code',
    `Your sign-in code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`,
    'otp',
  );
}

export async function sendOrgInviteEmail(to: string, token: string, orgName: string, inviterLabel: string): Promise<void> {
  const link = `${config.publicUrl}/invite?token=${encodeURIComponent(token)}`;
  await sendEmail(
    to,
    `${inviterLabel} invited you to join ${orgName} on focusKube`,
    `${inviterLabel} invited you to join "${orgName}" on focusKube, with access to the AI assistant.\n\nAccept the invite: ${link}\n\nThis link expires in ${config.org.inviteTtlDays} days. If you weren't expecting this, ignore this email.`,
    'organization-invite',
  );
}
