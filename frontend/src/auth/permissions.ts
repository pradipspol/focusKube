import { createContext, useContext } from 'react';
import type { Role } from '../api/types';

export interface Permissions {
  role: Role;
  canWrite: boolean;
  canDelete: boolean;
  canAdmin: boolean;
}

/** Mirror of the backend capability matrix in backend/src/auth/rbac.ts. */
export function capabilitiesFor(role: Role | undefined | null): Permissions {
  const effective: Role = role ?? 'viewer';
  const canDelete = effective === 'admin' || effective === 'editor';
  const canWrite = canDelete || effective === 'rwonly';
  const canAdmin = effective === 'admin';
  return { role: effective, canWrite, canDelete, canAdmin };
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  editor: 'Editor (read/write/delete)',
  rwonly: 'Read/Write',
  viewer: 'Viewer (read-only)',
};

/** Human-readable capability checklist for a role, used in the header hover card. */
export function describePermissions(role: Role | undefined | null): Array<{ label: string; granted: boolean }> {
  const perms = capabilitiesFor(role);
  return [
    { label: 'View resources', granted: true },
    { label: 'Create & edit resources', granted: perms.canWrite },
    { label: 'Delete resources', granted: perms.canDelete },
  ];
}

const PermissionsContext = createContext<Permissions>(capabilitiesFor('viewer'));

export const PermissionsProvider = PermissionsContext.Provider;

export function usePermissions(): Permissions {
  return useContext(PermissionsContext);
}
