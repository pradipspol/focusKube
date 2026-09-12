import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.smtp.url) return null;
  if (!transporter) transporter = nodemailer.createTransport(config.smtp.url);
  return transporter;
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // No SMTP configured — dev fallback so the flow is still testable locally.
    console.log(`[dev email] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail(
    to,
    'Reset your focusKube password',
    `Reset your password: ${link}\n\nThis link expires in ${config.passwordResetTtlMinutes} minutes. If you didn't request this, ignore this email.`,
  );
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  await sendEmail(
    to,
    'Your focusKube sign-in code',
    `Your sign-in code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`,
  );
}

export async function sendOrgInviteEmail(to: string, token: string, orgName: string, inviterLabel: string): Promise<void> {
  const link = `${config.publicUrl}/invite?token=${encodeURIComponent(token)}`;
  await sendEmail(
    to,
    `${inviterLabel} invited you to join ${orgName} on focusKube`,
    `${inviterLabel} invited you to join "${orgName}" on focusKube, with access to the AI assistant.\n\nAccept the invite: ${link}\n\nThis link expires in ${config.org.inviteTtlDays} days. If you weren't expecting this, ignore this email.`,
  );
}
