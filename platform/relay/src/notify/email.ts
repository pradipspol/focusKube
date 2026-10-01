import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logDebug, logError, logInfo } from '../logger.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.smtp.url) return null;
  if (!transporter) transporter = nodemailer.createTransport(config.smtp.url);
  return transporter;
}

async function sendEmail(
  to: string,
  subject: string,
  text: string,
  messageType: 'password-reset' | 'otp' | 'organization-invite',
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // No SMTP configured — dev fallback so the flow is still testable locally.
    logInfo('Email delivery skipped because SMTP is not configured', { messageType });
    return;
  }
  const startedAt = Date.now();
  logDebug('Email delivery started', { messageType });
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, text });
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
