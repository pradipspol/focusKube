// All HTTP-hardening middleware for this service lives here rather than inline in index.ts,
// so every security decision (and the reasoning behind it) is in one place instead of
// scattered across app.use() calls.
import helmet from 'helmet';
import cors from 'cors';
import type { Express } from 'express';

export interface SecurityOptions {
  /** config.corsOrigin — a comma-separated allowlist, or '*' for "allow any origin". */
  corsOrigin: string;
}

/** Mounts helmet + CORS. Call this once, as early in the middleware chain as possible
 * (after compression, before body parsing/routes). */
export function applySecurityMiddleware(app: Express, options: SecurityOptions): void {
  // This backend never renders HTML (it's a JSON API only, called by platform/frontend and
  // the AI relay) — the default CSP is meant for HTML documents and would only add noise
  // here, so it's turned off explicitly rather than shipping a policy nothing can violate.
  // The rest of helmet's defaults (nosniff, no-referrer, frameguard, HSTS, etc.) still apply.
  app.use(helmet({ contentSecurityPolicy: false }));

  // credentials:true + a reflected/wildcard origin would let ANY website read this API's
  // responses using the caller's own session cookie — safe only because CORS_ORIGIN defaults
  // to the Vite dev origin; explicitly refuse to combine credentials with '*' even if someone
  // sets CORS_ORIGIN=* in an env file, rather than silently becoming exploitable.
  const corsOriginIsWildcard = options.corsOrigin === '*';
  app.use(
    cors({
      origin: corsOriginIsWildcard ? true : options.corsOrigin.split(','),
      credentials: !corsOriginIsWildcard,
    }),
  );
}
