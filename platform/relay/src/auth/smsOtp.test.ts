import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { config } from '../config.js';
import { authRouter } from './routes.js';
import { authPagesRouter } from '../web/authPages.js';
import { applySecurityMiddleware } from '../security/security.js';

test('SMS OTP is unavailable by default and can be enabled without removing its flow', async () => {
  const previousValue = config.smsOtpEnabled;
  config.smsOtpEnabled = false;

  const app = express();
  applySecurityMiddleware(app);
  app.use(express.json());
  app.use('/v1/auth', authRouter);
  app.use(authPagesRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const page = await fetch(`${baseUrl}/otp`);
    const pageHtml = await page.text();
    assert.match(pageHtml, /data-sms-otp-enabled="false"/);
    assert.match(pageHtml, /type="email"/);
    assert.match(pageHtml, /Enter your email and we'll send a one-time code/);

    const request = await fetch(`${baseUrl}/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: '+15551234567', channel: 'sms' }),
    });
    assert.equal(request.status, 403);

    const verify = await fetch(`${baseUrl}/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: '+15551234567', channel: 'sms', code: '123456' }),
    });
    assert.equal(verify.status, 403);

    config.smsOtpEnabled = true;
    const enabledPage = await fetch(`${baseUrl}/otp`);
    assert.match(await enabledPage.text(), /data-sms-otp-enabled="true"/);
  } finally {
    config.smsOtpEnabled = previousValue;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});