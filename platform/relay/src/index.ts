import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'express-async-errors';
import { config } from './config.js';
import { devLicenseKey, licenseFromAuthHeader, lookupLicense, refundQuota, reserveQuota } from './licenseStore.js';
import { streamChatTurn, type ChatTool, type ChatTurnMessage } from './llm/chatProvider.js';
import { authRouter } from './auth/routes.js';
import { accountRouter } from './account/routes.js';
import { billingRouter, handleStripeWebhook } from './billing/routes.js';
import { orgRouter } from './org/routes.js';
import { devRouter } from './dev/routes.js';
import { webRouter } from './web/pages.js';
import { isStripeDemoMode, simulateCheckoutCompleted, getSimulatedSession } from './billing/stripe-sim.js';

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
  messages?: ChatTurnMessage[];
  model?: string;
  maxTokens?: number;
  /** The tool catalog the backend has already filtered by the session's RBAC role — the relay
   * has no Kubernetes knowledge of its own and never decides which tools exist, only forwards
   * whichever set the caller sends. */
  tools?: ChatTool[];
}

function buildSystemPrompt(context: unknown): string {
  return [
    'You are the focusKube AI assistant, embedded in a Kubernetes explorer UI.',
    'Help the user diagnose issues with the resource they currently have focused: explain what is wrong and cite specific evidence from the context below (status fields, events, related pods) rather than generic Kubernetes advice. You can also inspect and manage Helm releases — nothing outside the Kubernetes/Helm scope.',
    '',
    'Tools — call them yourself, directly, whenever they would help. Never ask the user "should I proceed?" or "do you want me to run this?" in your own reply instead of calling a tool: that produces plain text with no way for the user to actually respond, and nothing will happen.',
    '- Read tools (list_resources, get_resource, describe_resource, get_logs, get_events, helm_list_releases, helm_get_release_values, helm_get_release_manifest, helm_get_release_history, helm_search_charts) run immediately with no approval step of any kind. Call them the moment the context JSON below does not already answer the question, and cite what they return rather than guessing.',
    '- Write tools (scale_deployment, restart_deployment, apply_manifest, delete_resource, helm_install, helm_upgrade, helm_rollback, helm_uninstall) are never executed by you. The instant you call one, the system itself shows the user an approval card (Approve / Reject / Allow for this session) — that IS the permission step, so call the tool as soon as you have decided a change is warranted rather than asking about it first. You will get the real outcome back afterward as a tool result.',
    '- Never tell the user a change has been made until a tool result confirms it. If the user rejects a proposal, acknowledge that and do not repeat the same proposal without a good reason.',
    '- A tool result is evidence for you to interpret, not the answer itself. Once you have called every tool you need, always finish with your own written explanation in plain language — what the evidence means, and why (e.g. quote the specific log line or event that shows the cause). Never end a turn on a tool call alone and let the raw output stand in for your answer; the user is asking you to reason about it, not to see it.',
    '',
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
app.use('/v1/org', orgRouter);
app.use('/v1/dev', devRouter);

// Demo checkout page (only in demo mode)
app.get('/demo/checkout/:sessionId', (req, res) => {
  if (!isStripeDemoMode()) {
    return res.status(403).send('Demo mode not enabled');
  }
  const session = getSimulatedSession(req.params.sessionId);
  if (!session) {
    return res.status(404).send('Checkout session not found');
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Demo Checkout - FocusKube</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 500px; }
        .card { border: 1px solid #ddd; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .price { font-size: 32px; font-weight: bold; margin: 16px 0; }
        .details { color: #666; margin: 16px 0; }
        button { background: #007AFF; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; }
        button:hover { background: #0051D5; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Confirm Purchase</h1>
        <p class="details"><strong>Email:</strong> ${session.customer_email}</p>
        <p class="details"><strong>Plan:</strong> FocusKube Pro</p>
        <p class="details"><strong>Billing:</strong> Monthly</p>
        <div class="price">$19.99/month</div>
        <button onclick="completePurchase()">Complete Purchase</button>
        <div class="footer">
          This is a demo checkout — no real charge will be made.
        </div>
      </div>
      <script>
        async function completePurchase() {
          const btn = document.querySelector('button');
          btn.disabled = true;
          btn.textContent = 'Processing...';
          try {
            const res = await fetch('/v1/dev/stripe/webhook/checkout-completed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: '${session.id}' })
            });
            if (res.ok) {
              window.location.href = '${session.success_url}';
            } else {
              alert('Error completing purchase');
              btn.disabled = false;
              btn.textContent = 'Complete Purchase';
            }
          } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Complete Purchase';
          }
        }
      </script>
    </body>
    </html>
  `);
});

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

  const { context, messages, model, maxTokens, tools } = req.body as ChatRequestBody;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  // Reserved atomically before streaming, not read-then-decrement-after — the old order let
  // concurrent requests against the same pooled Team balance both pass the same check (see
  // licenseStore.ts's reserveQuota).
  if (!reserveQuota(key!)) {
    return res.status(429).json({ error: 'Quota exhausted' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // platform/backend's aiService.ts aborts its own fetch to this route when the user clicks
  // Stop (or when its WS connection drops) — Node surfaces that as this request's socket
  // closing, which we turn into an abort signal threaded into the actual LLM call so tokens
  // stop generating immediately instead of streaming to no one.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    await streamChatTurn(
      buildSystemPrompt(context),
      messages.map((m) => ({ role: m.role, content: m.content })),
      model || DEFAULT_MODEL,
      maxTokens ?? DEFAULT_MAX_TOKENS,
      tools ?? [],
      (event) => send(event),
      controller.signal,
    );
    res.write('data: [DONE]\n\n');
  } catch (err) {
    if (controller.signal.aborted) {
      // The client disconnected on purpose (Stop) — nothing left to write to, and the LLM call
      // itself still ran, so the quota reservation stands (see reserveQuota's doc comment: one
      // reservation per real relay round-trip, matching the cost actually incurred).
      return;
    }
    refundQuota(key!);
    send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  } finally {
    if (!res.writableEnded) res.end();
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
