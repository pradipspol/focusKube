import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'express-async-errors';
import { config } from './config.js';
import { decrementQuota, devLicenseKey, licenseFromAuthHeader, lookupLicense } from './licenseStore.js';
import { streamChatTurn } from './llm/chatProvider.js';
import { authRouter } from './auth/routes.js';
import { accountRouter } from './account/routes.js';
import { billingRouter, handleStripeWebhook } from './billing/routes.js';
import { webRouter } from './web/pages.js';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 12048;

const app = express();
app.use(cors());

// Stripe's signature check needs the exact raw bytes of the request body, so this route
// must be registered — with express.raw(), not express.json() — before the app-wide JSON
// body parser below runs for every other route.
app.post('/v1/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// The real LLM provider credentials (ANTHROPIC_API_KEY, or AZURE_OPENAI_API_KEY when
// AI_PROVIDER=azure-openai) live only here — this process is the one place in the whole
// system allowed to hold them. See llm/chatProvider.ts for the actual client(s).

interface ChatRequestBody {
  context?: unknown;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
}

function buildSystemPrompt(context: unknown): string {
  return [
    'You are the focusKube AI assistant, embedded in a Kubernetes explorer UI.',
    'Help the user diagnose issues with the resource they currently have focused: explain what is wrong and cite specific evidence from the context below (status fields, events, related pods) rather than generic Kubernetes advice.',
    'You are read-only in this phase — you cannot execute any change yourself. If a fix needs a mutation (restart, scale, rollback, edit), describe exactly what to do so the user can perform it manually; never claim to have made a change.',
    'Be concise and specific.',
    '',
    'Cluster context (JSON):',
    JSON.stringify(context ?? {}, null, 2),
  ].join('\n');
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/v1/auth', authRouter);
app.use('/v1/account', accountRouter);
app.use('/v1/billing', billingRouter);
app.use('/', webRouter);

// POST /v1/license/validate — looked up per call rather than a self-verifying token, since
// every AI call already has to reach this relay to enforce quota (see the plan's licensing
// section). Now backed by the real SQLite `licenses` table (see db.ts/licenseStore.ts) instead
// of an in-memory Map, but the request/response contract here is unchanged from Phase 1.
app.post('/v1/license/validate', (req, res) => {
  const key = licenseFromAuthHeader(req.headers.authorization);
  if (!key) return res.status(401).json({ error: 'Missing license key' });

  const record = lookupLicense(key);
  if (!record || record.status !== 'active') {
    return res.status(403).json({ error: 'License invalid or inactive' });
  }
  res.json(record);
});

// POST /v1/ai/chat — proxies one chat turn to Claude, streaming back a reduced
// {type: 'token' | 'tool_use' | 'error'} protocol terminated by `data: [DONE]`.
// This is intentionally not raw Anthropic SSE — platform/backend's aiService.ts is the
// only consumer, and this shape is all it needs.
app.post('/v1/ai/chat', async (req, res) => {
  const key = licenseFromAuthHeader(req.headers.authorization);
  const record = key ? lookupLicense(key) : undefined;
  if (!record || record.status !== 'active') {
    return res.status(403).json({ error: 'License invalid or inactive' });
  }
  if (record.quotaRemaining <= 0) {
    return res.status(429).json({ error: 'Quota exhausted' });
  }

  const { context, messages, model, maxTokens } = req.body as ChatRequestBody;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await streamChatTurn(
      buildSystemPrompt(context),
      messages.map((m) => ({ role: m.role, content: m.content })),
      model || DEFAULT_MODEL,
      maxTokens ?? DEFAULT_MAX_TOKENS,
      (event) => send(event),
    );
    decrementQuota(key!);
    res.write('data: [DONE]\n\n');
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  } finally {
    res.end();
  }
});

const server = http.createServer(app);
server.listen(config.port, () => {
  console.log(`focusKube AI relay listening on :${config.port}`);
  console.log(`Dev license key: ${devLicenseKey()}`);
  console.log(`AI provider: ${config.aiProvider}`);
  if (config.aiProvider === 'azure-openai') {
    if (!config.azureOpenai.apiKey || !config.azureOpenai.endpoint || !config.azureOpenai.deployment) {
      console.warn(
        'AI_PROVIDER=azure-openai but AZURE_OPENAI_API_KEY/ENDPOINT/DEPLOYMENT are not all set — /v1/ai/chat will fail until they are.',
      );
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY is not set — /v1/ai/chat will fail until it is.');
  }
});
