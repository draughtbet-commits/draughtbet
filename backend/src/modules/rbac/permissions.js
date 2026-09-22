// RBAC permission matrix. Authorization is role-based and DB-backed: every
// admin request loads AdminRoleAssignments fresh, so a revoke binds across
// devices immediately (no JWT role claims).
//
// Roles: SUPER_ADMIN (everything + role grants), FINANCE (money ops),
// RISK_COMPLIANCE (KYC/risk), SUPPORT (accounts + disputes),
// GAME_OPERATIONS (read-only), READ_ONLY_AUDITOR (read-only views).

export const ADMIN_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'FINANCE',
  'RISK_COMPLIANCE',
  'SUPPORT',
  'GAME_OPERATIONS',
  'READ_ONLY_AUDITOR'
]);

export const PERMISSIONS = Object.freeze({
  USERS_MANAGE: 'users.manage',              // ban / unban accounts
  WITHDRAWALS_READ: 'withdrawals.read',       // list withdrawal queue
  WITHDRAWALS_PROCESS: 'withdrawals.process', // approve / payout / reject
  VERIFICATION_REVIEW: 'verification.review', // list / approve / reject KYC cases
  DISPUTES_MANAGE: 'disputes.manage',         // list / decide / evidence
  RISK_REVIEW: 'risk.review',                 // risk events + case status
  LEDGER_ADJUST: 'ledger.adjust',             // sanctioned money correction
  SAFER_PLAY_LIFT: 'safer-play.lift',         // end timeout / self-exclusion
  ROLES_ADMIN: 'roles.admin',                 // grant / revoke roles
  AUDIT_READ: 'audit.read',                   // read the admin audit trail
  MATCH_EVIDENCE_READ: 'match.evidence.read'  // read-only match replay/evidence view
});

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS = Object.freeze({
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
  GAME_OPERATIONS: [PERMISSIONS.AUDIT_READ, PERMISSIONS.MATCH_EVIDENCE_READ],
  READ_ONLY_AUDITOR: [PERMISSIONS.WITHDRAWALS_READ, PERMISSIONS.AUDIT_READ]
});

export const roleHasPermission = (roleName, permission) =>
  (ROLE_PERMISSIONS[roleName] ?? []).includes(permission);

export const ROLE_DESCRIPTIONS = Object.freeze({
  SUPER_ADMIN: 'Full platform control: everything below plus role grants',
  FINANCE: 'Withdrawal review/payout, sanctioned ledger adjustments, audit read',
  RISK_COMPLIANCE: 'KYC review, safer-play lifts, risk case review, audit read',
  SUPPORT: 'Account status, dispute management, safer-play lifts, audit read',
  GAME_OPERATIONS: 'Read-only visibility into game operations (audit trail, match evidence)',
  READ_ONLY_AUDITOR: 'Read-only audit trail + withdrawal visibility'
});