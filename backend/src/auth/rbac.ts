import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../util/httpError.js';

export type Role = 'admin' | 'editor' | 'rwonly' | 'viewer';
export type Capability = 'read' | 'write' | 'delete' | 'admin';

export const ROLES: Role[] = ['admin', 'editor', 'rwonly', 'viewer'];
export const DEFAULT_ROLE: Role = 'viewer';

const CAPABILITIES: Record<Role, Set<Capability>> = {
  admin: new Set<Capability>(['read', 'write', 'delete', 'admin']),
  editor: new Set<Capability>(['read', 'write', 'delete']),
  rwonly: new Set<Capability>(['read', 'write']),
  viewer: new Set<Capability>(['read']),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

export function normalizeRole(value: unknown): Role {
  return isRole(value) ? value : DEFAULT_ROLE;
}

export function hasCapability(role: Role | undefined | null, cap: Capability): boolean {
  if (!role || !CAPABILITIES[role]) return false;
  return CAPABILITIES[role].has(cap);
}

/** Map an HTTP method to the capability required to perform it. */
export function capabilityForMethod(method: string): Capability {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return 'read';
  if (upper === 'DELETE') return 'delete';
  return 'write'; // POST / PUT / PATCH
}

function roleOf(req: Request): Role | null {
  return (req.authUser?.role as Role | undefined) ?? null;
}

/** Express middleware requiring a specific capability for the route. */
export function requireCapability(cap: Capability) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.authUser) throw new HttpError(401, 'Authentication required');
    if (!hasCapability(roleOf(req), cap)) {
      throw new HttpError(403, `Your role does not permit this action (requires "${cap}").`);
    }
    next();
  };
}

/**
 * Middleware that infers the required capability from the HTTP method and
 * enforces it. Mount on cluster-mutating routers so read-only roles are blocked
 * from create/update (write) and delete operations.
 */
export function guardByMethod(req: Request, _res: Response, next: NextFunction): void {
  if (!req.authUser) throw new HttpError(401, 'Authentication required');
  const cap = capabilityForMethod(req.method);
  if (!hasCapability(roleOf(req), cap)) {
    throw new HttpError(403, `Your role does not permit this action (requires "${cap}").`);
  }
  next();
}
