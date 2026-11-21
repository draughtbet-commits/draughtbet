import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AdminRole } from '../roles';
import type { AdminUser } from '../guards';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcRoot = path.resolve(__dirname, '../../../');

interface ModuleWithRegisterHooks {
  registerHooks?: (hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context?: { parentURL?: string }) => unknown
    ) => unknown;
  }) => void;
}

const modWithHooks = module as unknown as ModuleWithRegisterHooks;

if (typeof modWithHooks.registerHooks === 'function') {
  modWithHooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      let target = specifier;
      if (target.startsWith('@/')) {
        target = path.join(srcRoot, target.slice(2));
      } else if (
        (target.startsWith('./') || target.startsWith('../')) &&
        context.parentURL &&
        context.parentURL.startsWith('file:')
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        target = path.resolve(parentDir, target);
      }

      if (path.isAbsolute(target)) {
        const candidates = [
          target,
          `${target}.ts`,
          `${target}.tsx`,
          `${target}.js`,
          path.join(target, 'index.ts'),
          path.join(target, 'index.tsx')
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return nextResolve(`file:///${candidate.replace(/\\/g, '/')}`, context);
          }
        }
      }
      return nextResolve(specifier, context);
    }
  });
}

const { PERMISSIONS, ROLE_PERMISSIONS } = await import('../matrix');
const { requiresMfaVerification } = await import('../guards');
const { canAccessAdminRoute, getAdminRouteRule } = await import('../routes');
const { apiClient, purgeLegacyTokenStorage } = await import('../../api/client');

function makeUser(role: AdminRole, mfa?: AdminUser['mfa']): AdminUser {
  return {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@draughtbet.com`,
    username: role.toLowerCase(),
    fullName: `${role} Operator`,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
    mfa
  };
}

describe('Admin Page Route Guards, MFA Gate & HttpOnly Cookie Client (Issues #1, #7, #8)', () => {
  describe('Route-Level Authorization Matrix (Issue #8)', () => {
    const superAdmin = makeUser('SUPER_ADMIN');
    const finance = makeUser('FINANCE');
    const risk = makeUser('RISK_COMPLIANCE');
    const support = makeUser('SUPPORT');
    const gameOps = makeUser('GAME_OPERATIONS');
    const auditor = makeUser('READ_ONLY_AUDITOR');

    it('blocks unauthenticated (null) users from EVERY admin route', () => {
      const routes = [
        '/dashboard',
        '/players',
        '/finance/withdrawals',
        '/finance/ledger',
        '/compliance/kyc',
        '/compliance/risk',
        '/game-operations/matches',
        '/game-operations/disputes',
        '/support',
        '/configuration',
        '/configuration/financial',
        '/configuration/platform',
        '/configuration/feature-flags',
        '/configuration/maintenance',
        '/team',
        '/system/audit',
        '/system/health',
        '/system/notifications',
        '/system/simulation'
      ];
      for (const route of routes) {
        assert.equal(canAccessAdminRoute(null, route), false, `Expected null denied on ${route}`);
      }
    });

    it('enforces exact RBAC boundaries on all previously unguarded restricted pages', () => {
      // KYC Reviews -> VERIFICATION_REVIEW (RISK_COMPLIANCE & SUPER_ADMIN only)
      assert.equal(canAccessAdminRoute(superAdmin, '/compliance/kyc'), true);
      assert.equal(canAccessAdminRoute(risk, '/compliance/kyc'), true);
      assert.equal(canAccessAdminRoute(finance, '/compliance/kyc'), false);
      assert.equal(canAccessAdminRoute(support, '/compliance/kyc'), false);
      assert.equal(canAccessAdminRoute(gameOps, '/compliance/kyc'), false);
      assert.equal(canAccessAdminRoute(auditor, '/compliance/kyc'), false);

      // Risk & Safer Play -> RISK_REVIEW (RISK_COMPLIANCE & SUPER_ADMIN only)
      assert.equal(canAccessAdminRoute(risk, '/compliance/risk'), true);
      assert.equal(canAccessAdminRoute(finance, '/compliance/risk'), false);
      assert.equal(canAccessAdminRoute(support, '/compliance/risk'), false);

      // Finance Ledger -> WITHDRAWALS_READ (SUPER_ADMIN, FINANCE, READ_ONLY_AUDITOR)
      assert.equal(canAccessAdminRoute(finance, '/finance/ledger'), true);
      assert.equal(canAccessAdminRoute(auditor, '/finance/ledger'), true);
      assert.equal(canAccessAdminRoute(support, '/finance/ledger'), false);
      assert.equal(canAccessAdminRoute(gameOps, '/finance/ledger'), false);

      // Disputes Queue -> DISPUTES_MANAGE (SUPER_ADMIN, SUPPORT)
      assert.equal(canAccessAdminRoute(support, '/game-operations/disputes'), true);
      assert.equal(canAccessAdminRoute(finance, '/game-operations/disputes'), false);
      assert.equal(canAccessAdminRoute(auditor, '/game-operations/disputes'), false);

      // Support Cases -> USERS_MANAGE (SUPER_ADMIN, SUPPORT)
      assert.equal(canAccessAdminRoute(support, '/support'), true);
      assert.equal(canAccessAdminRoute(finance, '/support'), false);
      assert.equal(canAccessAdminRoute(risk, '/support'), false);

      // Staff & RBAC (/team) & Simulation Lab (/system/simulation) -> ROLES_ADMIN (SUPER_ADMIN only)
      assert.equal(canAccessAdminRoute(superAdmin, '/team'), true);
      assert.equal(canAccessAdminRoute(superAdmin, '/system/simulation'), true);
      for (const nonSuper of [finance, risk, support, gameOps, auditor]) {
        assert.equal(canAccessAdminRoute(nonSuper, '/team'), false);
        assert.equal(canAccessAdminRoute(nonSuper, '/system/simulation'), false);
      }

      // Configuration domain pages -> CONFIG_READ (SUPPORT lacks CONFIG_READ!)
      assert.equal(canAccessAdminRoute(support, '/configuration/financial'), false);
      assert.equal(canAccessAdminRoute(support, '/configuration/platform'), false);
      assert.equal(canAccessAdminRoute(support, '/configuration/versions'), false);
      // SUPPORT holds FLAGS_READ and MAINTENANCE_READ so those tabs remain accessible
      assert.equal(canAccessAdminRoute(support, '/configuration/feature-flags'), true);
      assert.equal(canAccessAdminRoute(support, '/configuration/maintenance'), true);
      assert.equal(canAccessAdminRoute(finance, '/configuration/financial'), true);
      assert.equal(canAccessAdminRoute(auditor, '/configuration/financial'), true);
    });

    it('fails closed to ROLES_ADMIN for any unrecognized admin route', () => {
      const rule = getAdminRouteRule('/secret-unmapped-module');
      assert.deepEqual(rule.anyOfPermissions, [PERMISSIONS.ROLES_ADMIN]);
      assert.equal(canAccessAdminRoute(superAdmin, '/secret-unmapped-module'), true);
      assert.equal(canAccessAdminRoute(finance, '/secret-unmapped-module'), false);
      assert.equal(canAccessAdminRoute(support, '/secret-unmapped-module'), false);
    });
  });

  describe('Admin MFA UI Gate (Issue #1)', () => {
    it('requires MFA challenge when MFA is enforced and session is not verified', () => {
      const unverified = makeUser('SUPER_ADMIN', {
        enforced: true,
        provisioned: true,
        enabled: true,
        verified: false,
        recoveryCodesRemaining: 8
      });
      const verified = makeUser('SUPER_ADMIN', {
        enforced: true,
        provisioned: true,
        enabled: true,
        verified: true,
        recoveryCodesRemaining: 8
      });
      const optional = makeUser('SUPER_ADMIN', {
        enforced: false,
        provisioned: false,
        enabled: false,
        verified: false,
        recoveryCodesRemaining: 0
      });

      assert.equal(requiresMfaVerification(unverified), true);
      assert.equal(requiresMfaVerification(verified), false);
      assert.equal(requiresMfaVerification(optional), false);
    });
  });

  describe('Cookie-Only ApiClient & Zero Token Storage (Issue #7)', () => {
    const recorded: Array<{ url: string; init: RequestInit }> = [];

    beforeEach(() => {
      recorded.length = 0;
      apiClient.clearAuth();
    });

    it('sends credentials=include, X-Auth-Mode=cookie, and X-CSRF-Token on mutations without Bearer headers', async () => {
      apiClient.setSessionMetadata({
        csrfToken: 'nonce123.sig456',
        expiresIn: 900
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
        recorded.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        } as unknown as Response;
      }) as typeof fetch;

      try {
        await apiClient.post('/admin/config/drafts', { changeReason: 'test reason' });
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].init.credentials, 'include');
        const headers = recorded[0].init.headers as Record<string, string>;
        assert.equal(headers['x-auth-mode'], 'cookie');
        assert.equal(headers['X-CSRF-Token'], 'nonce123.sig456');
        assert.equal(headers['Authorization'], undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('purges any legacy localStorage/sessionStorage token keys cleanly', () => {
      const localMap = new Map<string, string>([
        ['draughtbet_admin_token', 'stale-jwt'],
        ['draughtbet_admin_refresh', 'stale-refresh'],
        ['unrelated_key', 'keep']
      ]);
      const sessionMap = new Map<string, string>([
        ['draughtbet_admin_token', 'stale-jwt']
      ]);

      const prevWindow = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = {
        localStorage: {
          removeItem: (k: string) => localMap.delete(k)
        },
        sessionStorage: {
          removeItem: (k: string) => sessionMap.delete(k)
        }
      };

      try {
        purgeLegacyTokenStorage();
        assert.equal(localMap.has('draughtbet_admin_token'), false);
        assert.equal(localMap.has('draughtbet_admin_refresh'), false);
        assert.equal(localMap.get('unrelated_key'), 'keep');
        assert.equal(sessionMap.has('draughtbet_admin_token'), false);
      } finally {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    });
  });
});
