import type { AdminRole } from './roles';
import { type Permission, PERMISSIONS, rolesHavePermission } from './matrix';

export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  fullName: string | null;
  roles: AdminRole[];
  permissions: Permission[];
}

export type ConfigDomain =
  | 'PLATFORM'
  | 'FINANCIAL'
  | 'TIERS'
  | 'GAME'
  | 'MATCHMAKING'
  | 'SAFER_PLAY'
  | 'KYC';

export function canAccessPermission(user: AdminUser | null, permission: Permission): boolean {
  if (!user || !user.roles || user.roles.length === 0) return false;
  if (Array.isArray(user.permissions) && user.permissions.includes(permission)) {
    return true;
  }
  return rolesHavePermission(user.roles, permission);
}

export function hasAnyRole(user: AdminUser | null, allowedRoles: readonly AdminRole[]): boolean {
  if (!user || !user.roles || user.roles.length === 0) return false;
  return user.roles.some((r) => allowedRoles.includes(r));
}

/**
 * Mirrors backend `checkDomainPermissions` in `backend/src/modules/config/controller.js`.
 * Note: UI checks are for visibility/ergonomics only; backend RBAC remains authoritative.
 */
export function canProposeDomain(user: AdminUser | null, domain: ConfigDomain): boolean {
  if (!user) return false;
  if (hasAnyRole(user, ['SUPER_ADMIN'])) return true;

  switch (domain) {
    case 'FINANCIAL':
    case 'TIERS':
      return canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_FINANCIAL);
    case 'GAME':
    case 'MATCHMAKING':
      return canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_GAME);
    case 'SAFER_PLAY':
    case 'KYC':
      return canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_COMPLIANCE);
    case 'PLATFORM':
      return (
        canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_FINANCIAL) ||
        canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_GAME) ||
        canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_COMPLIANCE)
      );
    default:
      return false;
  }
}

export function canProposeAnyConfig(user: AdminUser | null): boolean {
  if (!user) return false;
  return (
    hasAnyRole(user, ['SUPER_ADMIN']) ||
    canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_FINANCIAL) ||
    canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_GAME) ||
    canAccessPermission(user, PERMISSIONS.CONFIG_PROPOSE_COMPLIANCE)
  );
}
