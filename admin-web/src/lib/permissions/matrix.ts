import type { AdminRole } from './roles';

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
  AUDIT_READ: 'audit.read',
  // Phase 4: Platform Configuration & Governance permissions (synchronized with backend/src/modules/rbac/permissions.js)
  CONFIG_READ: 'config.read',
  CONFIG_PROPOSE_FINANCIAL: 'config.propose.financial',
  CONFIG_PROPOSE_GAME: 'config.propose.game',
  CONFIG_PROPOSE_COMPLIANCE: 'config.propose.compliance',
  CONFIG_APPROVE: 'config.approve',
  CONFIG_ACTIVATE: 'config.activate',
  FLAGS_READ: 'flags.read',
  FLAGS_MANAGE: 'flags.manage',
  FLAGS_KILLSWITCH: 'flags.killswitch',
  MAINTENANCE_READ: 'maintenance.read',
  MAINTENANCE_MANAGE: 'maintenance.manage',
  TEMPLATES_MANAGE: 'templates.manage'
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  FINANCE: [
    PERMISSIONS.WITHDRAWALS_READ,
    PERMISSIONS.WITHDRAWALS_PROCESS,
    PERMISSIONS.LEDGER_ADJUST,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.CONFIG_PROPOSE_FINANCIAL,
    PERMISSIONS.CONFIG_APPROVE,
    PERMISSIONS.FLAGS_READ,
    PERMISSIONS.MAINTENANCE_READ
  ],
  RISK_COMPLIANCE: [
    PERMISSIONS.VERIFICATION_REVIEW,
    PERMISSIONS.RISK_REVIEW,
    PERMISSIONS.SAFER_PLAY_LIFT,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.CONFIG_PROPOSE_COMPLIANCE,
    PERMISSIONS.CONFIG_APPROVE,
    PERMISSIONS.FLAGS_READ,
    PERMISSIONS.FLAGS_KILLSWITCH,
    PERMISSIONS.MAINTENANCE_READ
  ],
  SUPPORT: [
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.DISPUTES_MANAGE,
    PERMISSIONS.SAFER_PLAY_LIFT,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.FLAGS_READ,
    PERMISSIONS.MAINTENANCE_READ
  ],
  GAME_OPERATIONS: [
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.CONFIG_PROPOSE_GAME,
    PERMISSIONS.FLAGS_READ,
    PERMISSIONS.FLAGS_KILLSWITCH,
    PERMISSIONS.MAINTENANCE_READ
  ],
  READ_ONLY_AUDITOR: [
    PERMISSIONS.WITHDRAWALS_READ,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.FLAGS_READ,
    PERMISSIONS.MAINTENANCE_READ
  ]
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function rolesHavePermission(roles: readonly AdminRole[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}
