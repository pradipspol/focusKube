import twilio from 'twilio';
import { config } from '../config.js';

let client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> | null {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  if (!client) client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return client;
}

async function sendSms(to: string, body: string): Promise<void> {
  const c = getClient();
  if (!c || !config.twilio.fromNumber) {
    // No Twilio configured — dev fallback so the flow is still testable locally.
    console.log(`[dev sms] to=${to}\n${body}`);
    return;
  }
  await c.messages.create({ to, from: config.twilio.fromNumber, body });
}

export async function sendOtpSms(to: string, code: string): Promise<void> {
  await sendSms(to, `Your focusKube sign-in code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`);
}
