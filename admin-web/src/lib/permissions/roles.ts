export const ADMIN_ROLES = [
  'SUPER_ADMIN',
  'FINANCE',
  'RISK_COMPLIANCE',
  'SUPPORT',
  'GAME_OPERATIONS',
  'READ_ONLY_AUDITOR'
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Full platform control: everything below plus role grants',
  FINANCE: 'Withdrawal review/payout, sanctioned ledger adjustments, audit read',
  RISK_COMPLIANCE: 'KYC review, safer-play lifts, risk case review, audit read',
  SUPPORT: 'Account status, dispute management, safer-play lifts, audit read',
  GAME_OPERATIONS: 'Read-only visibility into game operations (audit trail)',
  READ_ONLY_AUDITOR: 'Read-only audit trail + withdrawal visibility'
};

export const ROLE_COLORS: Record<AdminRole, { bg: string; text: string; border: string }> = {
  SUPER_ADMIN: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  FINANCE: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  RISK_COMPLIANCE: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
  SUPPORT: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  GAME_OPERATIONS: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  READ_ONLY_AUDITOR: { bg: 'bg-slate-500/10', text: 'text-slate-300', border: 'border-slate-500/30' }
};

