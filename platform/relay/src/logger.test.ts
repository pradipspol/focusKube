import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import express from 'express';

let temporaryDirectory: string | undefined;

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

it('writes request lifecycle logs asynchronously with user context and no secret values', async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'focuskube-logger-'));
  process.env.FOCUSKUBE_LOG_FILE = path.join(temporaryDirectory, 'relay.jsonl');
  const { flushLogs, logDebug, logError, logInfo, logWarning, requestErrorHandler, requestLogging, updateLogContext } =
    await import('./logger.js');

  logDebug('Diagnostic debug message', { apiKey: 'debug-secret-value' });
  logInfo('Diagnostic information message');
  logWarning('Diagnostic warning message');
  logError('Diagnostic error message', new Error('password=error-secret-value'), { password: 'error-password-value' });
  const networkCause = Object.assign(new Error('proxy password=network-secret-value'), { code: 'ECONNRESET' });
  logError('Diagnostic transport message', new TypeError('fetch failed', { cause: networkCause }));

  const app = express();
  app.use(express.json());
  app.use(requestLogging);
  app.post('/records/:recordId', (req, res) => {
    updateLogContext({ userId: 'user-42' });
    res.json({ ok: true, sessionToken: 'response-secret-value' });
  });
  app.post('/seats', (req, res) => {
    res.status(400).json({ error: 'seats must be a number' });
  });
  app.get('/failure', () => {
    throw new Error('password=exception-secret-value');
  });
  app.use(requestErrorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/records/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer request-secret-value' },
      body: JSON.stringify({ password: 'request-password-value', displayName: 'Example' }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('x-request-id'));
    await response.arrayBuffer();
    const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/seats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seats: 'not-a-number' }),
    });
    assert.equal(invalidResponse.status, 400);
    await invalidResponse.arrayBuffer();
    const failedResponse = await fetch(`http://127.0.0.1:${address.port}/failure`);
    assert.equal(failedResponse.status, 500);
    const failedBody = (await failedResponse.json()) as { error: string; requestId: string };
    assert.equal(failedBody.error, 'Internal server error');
    assert.ok(failedBody.requestId);
    assert.equal(failedResponse.headers.get('x-request-id'), failedBody.requestId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await flushLogs();

    const entries = (await readFile(process.env.FOCUSKUBE_LOG_FILE!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);
    const start = entries.find((entry) => entry.msg === 'HTTP request started');
    const complete = entries.find((entry) => entry.msg === 'HTTP request completed with status 200');
    const validationFailure = entries.find((entry) => entry.msg === 'HTTP request failed with status 400');
    const failed = entries.find((entry) => entry.output?.statusCode === 500);

    assert.equal(start?.level, 'debug');
    assert.equal(complete?.level, 'info');
    assert.equal(complete?.context.userId, 'user-42');
    assert.equal(validationFailure?.reason, 'seats must be a number');
    assert.equal(validationFailure?.level, 'error');
    assert.equal(failed?.level, 'error');
    assert.equal(failed?.errorType, 'Error');
    assert.equal(entries.find((entry) => entry.msg === 'Diagnostic debug message')?.level, 'debug');
    assert.equal(entries.find((entry) => entry.msg === 'Diagnostic information message')?.level, 'info');
    assert.equal(entries.find((entry) => entry.msg === 'Diagnostic warning message')?.level, 'warn');
    assert.equal(entries.find((entry) => entry.msg === 'Diagnostic error message')?.level, 'error');
    const transportError = entries.find((entry) => entry.msg === 'Diagnostic transport message')?.error;
    assert.equal(transportError?.causeType, 'Error');
    assert.equal(transportError?.causeCode, 'ECONNRESET');
    assert.deepEqual(complete?.input.bodyFields, ['[redacted]', 'displayName']);
    assert.deepEqual(complete?.output.responseFields, ['ok', '[redacted]']);
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes('request-secret-value'), false);
    assert.equal(serialized.includes('request-password-value'), false);
    assert.equal(serialized.includes('response-secret-value'), false);
    assert.equal(serialized.includes('debug-secret-value'), false);
    assert.equal(serialized.includes('error-secret-value'), false);
    assert.equal(serialized.includes('error-password-value'), false);
    assert.equal(serialized.includes('network-secret-value'), false);
    assert.equal(serialized.includes('exception-secret-value'), false);
    assert.match(serialized, /password=\[redacted\]/);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});