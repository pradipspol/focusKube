// Entry point for all of this service's HTTP-hardening middleware — index.ts calls this
// once instead of assembling helmet/CSP/CORS inline.
import cors from 'cors';
import type { Express } from 'express';
import { applyContentSecurityPolicy } from './csp.js';

export { runWithCspNonce, currentNonce } from './csp.js';
export { isValidEmail, validateOrgName, isValidAvatarDataUrl } from './validation.js';

/** Mounts CSP (with its per-request nonce) and CORS. Call this once, immediately after
 * compression and before body parsing/routes. */
export function applySecurityMiddleware(app: Express): void {
  applyContentSecurityPolicy(app);
  app.use(cors());
}
