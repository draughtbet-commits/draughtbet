import { AdminRole } from './roles';

export const PERMISSIONS = {
  USERS_MANAGE: 'users.manage',
  WITHDRAWALS_READ: 'withdrawals.read',
  WITHDRAWALS_PROCESS: 'withdrawals.process',
  VERIFICATION_REVIEW: 'verification.review',
  DISPUTES_MANAGE: 'disputes.manage',
  RISK_REVIEW: 'risk.review',
  LEDGER_ADJUST: 'ledger.adjust',
  SAFER_PLAY_LIFT: 'safer-play.lift',
  ROLES_ADMIN: 'roles.admin',
  AUDIT_READ: 'audit.read'
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  FINANCE: [
    PERMISSIONS.WITHDRAWALS_READ,
    PERMISSIONS.WITHDRAWALS_PROCESS,
    PERMISSIONS.LEDGER_ADJUST,
    PERMISSIONS.AUDIT_READ
  ],
  RISK_COMPLIANCE: [
    PERMISSIONS.VERIFICATION_REVIEW,
    PERMISSIONS.RISK_REVIEW,
    PERMISSIONS.SAFER_PLAY_LIFT,
    PERMISSIONS.AUDIT_READ
  ],
  SUPPORT: [
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.DISPUTES_MANAGE,
    PERMISSIONS.SAFER_PLAY_LIFT,
    PERMISSIONS.AUDIT_READ
  ],
  GAME_OPERATIONS: [PERMISSIONS.AUDIT_READ],
  READ_ONLY_AUDITOR: [PERMISSIONS.WITHDRAWALS_READ, PERMISSIONS.AUDIT_READ]
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function rolesHavePermission(roles: readonly AdminRole[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

