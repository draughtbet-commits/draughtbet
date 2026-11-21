import { PERMISSIONS, type Permission } from './matrix';
import { type AdminUser, canAccessPermission, hasAnyPermission } from './guards';

export interface AdminRouteRule {
  /** Route path (exact or prefix depending on `exact`). */
  path: string;
  /** If true, matches only the exact path (ignoring trailing slash). */
  exact?: boolean;
  /** User must possess AT LEAST ONE of these permissions. Empty array = any authenticated admin role. */
  anyOfPermissions: readonly Permission[];
  /** Human-readable section name for access-denied diagnostics. */
  section: string;
}

/**
 * Authoritative client-side route authorization map synchronized with backend
 * RBAC enforcement (`backend/src/modules/admin/controller.js` and sub-routers).
 *
 * Defense in depth: AdminShell enforces this map BEFORE rendering child pages
 * so unauthorized roles never mount restricted views or fire protected API calls.
 * Backend RBAC remains the security authority on every endpoint.
 *
 * Fail-closed default: any unrecognized admin route falls back to ROLES_ADMIN.
 */
export const ADMIN_ROUTE_RULES: readonly AdminRouteRule[] = [
  // Open to any authenticated admin role
  { path: '/dashboard', exact: true, anyOfPermissions: [], section: 'Operations Dashboard' },
  { path: '/profile', exact: true, anyOfPermissions: [], section: 'Operator Profile & MFA' },
  { path: '/access-denied', exact: true, anyOfPermissions: [], section: 'Access Denied' },
  { path: '/players', anyOfPermissions: [], section: 'Player Directory' },
  { path: '/game-operations/matches', anyOfPermissions: [], section: 'Match Monitor' },
  { path: '/system/health', anyOfPermissions: [], section: 'System Health' },
  { path: '/system/notifications', anyOfPermissions: [], section: 'System Notifications' },

  // Financial Operations
  {
    path: '/finance/withdrawals',
    anyOfPermissions: [PERMISSIONS.WITHDRAWALS_READ],
    section: 'Withdrawal Queue'
  },
  {
    path: '/finance/ledger',
    anyOfPermissions: [PERMISSIONS.WITHDRAWALS_READ],
    section: 'Top-Ups & Ledger'
  },

  // Risk & Compliance
  {
    path: '/compliance/kyc',
    anyOfPermissions: [PERMISSIONS.VERIFICATION_REVIEW],
    section: 'KYC Reviews'
  },
  {
    path: '/compliance/risk',
    anyOfPermissions: [PERMISSIONS.RISK_REVIEW],
    section: 'Risk & Safer Play'
  },

  // Game Operations — Disputes
  {
    path: '/game-operations/disputes',
    anyOfPermissions: [PERMISSIONS.DISPUTES_MANAGE],
    section: 'Disputes Queue'
  },

  // Support
  {
    path: '/support',
    anyOfPermissions: [PERMISSIONS.USERS_MANAGE],
    section: 'Support Cases'
  },

  // Platform Control & Configuration (ordered specific -> general)
  {
    path: '/configuration/feature-flags',
    anyOfPermissions: [PERMISSIONS.FLAGS_READ],
    section: 'Feature Flags'
  },
  {
    path: '/configuration/maintenance',
    anyOfPermissions: [PERMISSIONS.MAINTENANCE_READ],
    section: 'Maintenance Mode'
  },
  {
    path: '/configuration/approvals',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Configuration Approvals'
  },
  {
    path: '/configuration/versions',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Configuration Version History'
  },
  {
    path: '/configuration/notifications',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Notification Templates'
  },
  {
    path: '/configuration/platform',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Platform Settings Configuration'
  },
  {
    path: '/configuration/game',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Game Configuration'
  },
  {
    path: '/configuration/financial',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Financial Configuration'
  },
  {
    path: '/configuration/kyc',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'KYC Configuration'
  },
  {
    path: '/configuration/safer-play',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Safer Play Configuration'
  },
  {
    path: '/configuration/matchmaking',
    anyOfPermissions: [PERMISSIONS.CONFIG_READ],
    section: 'Matchmaking Configuration'
  },
  {
    path: '/configuration',
    exact: true,
    anyOfPermissions: [
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.FLAGS_READ,
      PERMISSIONS.MAINTENANCE_READ
    ],
    section: 'Platform Configuration Overview'
  },

  // Administration & Audit
  {
    path: '/team',
    anyOfPermissions: [PERMISSIONS.ROLES_ADMIN],
    section: 'Staff & RBAC Administration'
  },
  {
    path: '/system/audit',
    anyOfPermissions: [PERMISSIONS.AUDIT_READ],
    section: 'Audit Trail'
  },
  {
    path: '/system/simulation',
    anyOfPermissions: [PERMISSIONS.ROLES_ADMIN],
    section: 'Simulation Lab'
  }
];

const DEFAULT_FALLBACK_RULE: AdminRouteRule = {
  path: '*',
  anyOfPermissions: [PERMISSIONS.ROLES_ADMIN],
  section: 'Restricted Administrative Section'
};

export function normalizeAdminPathname(pathname: string): string {
  if (!pathname) return '/';
  const cleaned = pathname.split('?')[0].split('#')[0];
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

export function getAdminRouteRule(pathname: string): AdminRouteRule {
  const normalized = normalizeAdminPathname(pathname);
  for (const rule of ADMIN_ROUTE_RULES) {
    if (rule.exact) {
      if (normalized === rule.path) return rule;
    } else if (normalized === rule.path || normalized.startsWith(`${rule.path}/`)) {
      return rule;
    }
  }
  return DEFAULT_FALLBACK_RULE;
}

export function canAccessAdminRoute(user: AdminUser | null, pathname: string): boolean {
  if (!user || !Array.isArray(user.roles) || user.roles.length === 0) {
    return false;
  }
  const rule = getAdminRouteRule(pathname);
  if (rule.anyOfPermissions.length === 0) {
    return true;
  }
  if (rule.anyOfPermissions.length === 1) {
    return canAccessPermission(user, rule.anyOfPermissions[0]);
  }
  return hasAnyPermission(user, rule.anyOfPermissions);
}
