// CSP + the per-request nonce it depends on live here, isolated from index.ts and from
// web/layout.ts, so both can consume it without owning any of the security decisions.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import helmet from 'helmet';
import type { Express, RequestHandler } from 'express';

// The nonce travels through AsyncLocalStorage rather than as a parameter threaded through
// every page()/renderTemplate() call site across every routes file — this way the CSP header
// helmet sends and the nonce stamped into the HTML (see web/layout.ts) are always the same
// value for a given request, with zero call-site changes anywhere else in the app.
const nonceStore = new AsyncLocalStorage<string>();

export function runWithCspNonce<T>(nonce: string, fn: () => T): T {
  return nonceStore.run(nonce, fn);
}

/** The current request's CSP nonce. Empty outside of a request (e.g. at module load time). */
export function currentNonce(): string {
  return nonceStore.getStore() ?? '';
}

/** Generates one nonce per request and makes it available to both currentNonce() (used by
 * web/layout.ts to stamp inline <script>/<style> tags) and helmet's directive functions
 * below (via res.locals.nonce) — must run before contentSecurityPolicy() in the chain. */
export const cspNonceMiddleware: RequestHandler = (_req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  runWithCspNonce(nonce, next);
};

/** Strict, nonce-gated CSP — no 'unsafe-inline' for scripts or styles. Every inline
 * <script>/<style> this service emits is nonced by web/layout.ts; the only allowed
 * non-self script host is Razorpay's checkout SDK (pay-razorpay.html loads it by <script src>,
 * which doesn't need a nonce since it's allowed by host instead). */
export const contentSecurityPolicy = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', (_req, res: any) => `'nonce-${res.locals.nonce}'`],
      styleSrc: ["'self'", (_req, res: any) => `'nonce-${res.locals.nonce}'`],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://*.razorpay.com'],
      frameSrc: ['https://*.razorpay.com', 'https://api.razorpay.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  // Razorpay's checkout iframe/script are cross-origin subresources without their own
  // CORP headers — COEP would silently block them.
  crossOriginEmbedderPolicy: false,
});

/** Mounts the nonce middleware followed by the CSP header itself — call once, before any
 * route that renders HTML (and before body parsing/CORS, order doesn't matter for those). */
export function applyContentSecurityPolicy(app: Express): void {
  app.use(cspNonceMiddleware);
  app.use(contentSecurityPolicy);
}
