import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { sendOtpEmail } from './email.js';

test('email delivery uses Brevo API when configured', async (context) => {
  const originalApiKey = config.brevo.apiKey;
  const originalFrom = config.smtp.from;
  config.brevo.apiKey = 'test-brevo-api-key';
  config.smtp.from = 'FocusKube <no-reply@example.com>';
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 201 });
  });

  try {
    await sendOtpEmail('recipient@example.com', '123456');
    assert.equal(requestUrl, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(new Headers(requestInit?.headers).get('api-key'), 'test-brevo-api-key');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      sender: { email: 'no-reply@example.com', name: 'FocusKube' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Your focusKube sign-in code',
      textContent: 'Your sign-in code is 123456. It expires in 10 minutes.',
    });
  } finally {
    config.brevo.apiKey = originalApiKey;
    config.smtp.from = originalFrom;
  }
});

test('email delivery surfaces Brevo API errors instead of silently switching transports', async (context) => {
  const originalApiKey = config.brevo.apiKey;
  config.brevo.apiKey = 'test-brevo-api-key';
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));

  try {
    await assert.rejects(sendOtpEmail('recipient@example.com', '123456'), /Brevo email API returned HTTP 401/);
  } finally {
    config.brevo.apiKey = originalApiKey;
  }
});