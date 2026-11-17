import { AdminRole } from './roles';
import { Permission, rolesHavePermission } from './matrix';

export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  fullName: string | null;
  roles: AdminRole[];
  permissions: Permission[];
}

export function canAccessPermission(user: AdminUser | null, permission: Permission): boolean {
  if (!user || !user.roles || user.roles.length === 0) return false;
  return rolesHavePermission(user.roles, permission);
}

export function hasAnyRole(user: AdminUser | null, allowedRoles: readonly AdminRole[]): boolean {
  if (!user || !user.roles || user.roles.length === 0) return false;
  return user.roles.some((r) => allowedRoles.includes(r));
}

