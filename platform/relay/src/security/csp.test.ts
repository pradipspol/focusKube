import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { applySecurityMiddleware, currentNonce } from './security.js';

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  applySecurityMiddleware(app);
  app.get('/nonce', async (_req, res) => {
    await Promise.resolve();
    res.json({ nonce: currentNonce() });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('CSP assigns one opaque nonce per request and preserves it across async work', async () => {
  await withApp(async (baseUrl) => {
    const [first, second] = await Promise.all([fetch(`${baseUrl}/nonce`), fetch(`${baseUrl}/nonce`)]);
    const [firstBody, secondBody] = await Promise.all([first.json() as Promise<{ nonce: string }>, second.json() as Promise<{ nonce: string }>]);
    assert.match(firstBody.nonce, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(firstBody.nonce, secondBody.nonce);

    const csp = first.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes(`script-src 'self' https://checkout.razorpay.com 'nonce-${firstBody.nonce}'`));
    assert.ok(csp.includes(`style-src 'self' 'nonce-${firstBody.nonce}'`));
    assert.match(csp, /script-src[^;]*https:\/\/checkout\.razorpay\.com/);
    assert.doesNotMatch(csp, /'unsafe-inline'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});
