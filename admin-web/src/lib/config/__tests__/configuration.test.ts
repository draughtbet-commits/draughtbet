import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminProfileResponse, ConfigDomainName } from '../../api/types';
import type { AdminRole } from '../../permissions/roles';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcRoot = path.resolve(__dirname, '../../../');
(globalThis as Record<string, unknown>).__TEST_REACT = React;

interface ModuleWithRegisterHooks {
  registerHooks?: (hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context?: { parentURL?: string }) => unknown
    ) => unknown;
    load?: (
      url: string,
      context: unknown,
      nextLoad: (url: string, context?: unknown) => unknown
    ) => unknown;
  }) => void;
}

const modWithHooks = module as unknown as ModuleWithRegisterHooks;

// Register synchronous resolution & TSX transpilation hooks for Node 24 test runner
if (typeof modWithHooks.registerHooks === 'function') {
  modWithHooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'next/link') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export default function Link({ href, className, children }) { return globalThis.__TEST_REACT.createElement("a", { href, className }, children); }'
        };
      }
      if (specifier === 'next/navigation') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export const usePathname = () => "/configuration/financial"; export const useRouter = () => ({ push: () => {} });'
        };
      }
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
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.tsx')) {
        const filePath = fileURLToPath(url);
        const rawSource = fs.readFileSync(filePath, 'utf8');
        const transpiled = ts.transpileModule(rawSource, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.React
          },
          fileName: filePath
        });
        return {
          format: 'module',
          shortCircuit: true,
          source: transpiled.outputText
        };
      }
      return nextLoad(url, context);
    }
  });
}

const {
  DEFAULT_CONFIG_PAYLOAD,
  computeConfigDiff,
  koboToNairaInput,
  nairaInputToKobo,
  formatNairaWithKobo,
  formatConfigFieldValue
} = await import('../diff');

const { PERMISSIONS, roleHasPermission, rolesHavePermission } = await import(
  '../../permissions/matrix'
);
const {
  canAccessPermission,
  canProposeDomain,
  canProposeAnyConfig
} = await import('../../permissions/guards');
const { adminApi } = await import('../../api/admin');
const { apiClient, ApiError } = await import('../../api/client');

describe('Phase 4 Milestone 4 — Configuration Management UI & Integration Suite', () => {
  describe('BigInt / Minor-Unit (Kobo) Financial Conversion Utilities', () => {
    it('converts canonical kobo strings to Naira strings without floating-point arithmetic', () => {
      assert.equal(koboToNairaInput('100000'), '1000');
      assert.equal(koboToNairaInput('50000000'), '500000');
      assert.equal(koboToNairaInput('12345'), '123.45');
      assert.equal(koboToNairaInput('5'), '0.05');
      assert.equal(koboToNairaInput('0'), '0');
    });

    it('converts Naira input strings back to exact integer kobo strings', () => {
      assert.equal(nairaInputToKobo('1000'), '100000');
      assert.equal(nairaInputToKobo('1,500.50'), '150050');
      assert.equal(nairaInputToKobo('0.01'), '1');
      assert.equal(nairaInputToKobo('999999999999.99'), '99999999999999');
      assert.equal(nairaInputToKobo('-500'), null);
      assert.equal(nairaInputToKobo('12.345'), null);
      assert.equal(nairaInputToKobo('abc'), null);
    });

    it('formats kobo values with explicit Naira and kobo dual display', () => {
      const formatted = formatNairaWithKobo('100000');
      assert.match(formatted, /₦1,000\.00/);
      assert.match(formatted, /100,000 kobo/);
    });
  });

  describe('Structured Version Comparison Engine (computeConfigDiff)', () => {
    it('reports zero changes when comparing identical payloads', () => {
      const summary = computeConfigDiff(DEFAULT_CONFIG_PAYLOAD, DEFAULT_CONFIG_PAYLOAD);
      assert.equal(summary.totalChanged, 0);
      assert.equal(summary.totalAdded, 0);
      assert.equal(summary.totalRemoved, 0);
      assert.equal(summary.modifiedDomains.length, 0);
      assert.equal(summary.isRestricted, false);
      assert.ok(summary.totalUnchanged >= 30);
    });

    it('detects operational (non-restricted) changes in PLATFORM, GAME, and MATCHMAKING', () => {
      const modified = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      modified.platform.supportEmail = 'ops@draughtbet.com';
      modified.game.timeControlSeconds = 45;
      modified.matchmaking.queueTimeoutSeconds = 180;

      const summary = computeConfigDiff(DEFAULT_CONFIG_PAYLOAD, modified);
      assert.equal(summary.totalChanged, 3);
      assert.deepEqual(summary.modifiedDomains, ['PLATFORM', 'GAME', 'MATCHMAKING']);
      assert.equal(summary.isRestricted, false);
    });

    it('flags restricted Maker-Checker domains when FINANCIAL, TIERS, SAFER_PLAY, or KYC change', () => {
      const modified = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      modified.financial.commissionPercent = 12;
      modified.tiers.MASTER.maxStake = '4000000';
      modified.saferPlay.limitRaiseCoolingHours = 48;
      modified.kyc.requireVerificationForCallouts = false;

      const summary = computeConfigDiff(DEFAULT_CONFIG_PAYLOAD, modified);
      assert.equal(summary.totalChanged, 4);
      assert.deepEqual(summary.modifiedDomains, ['FINANCIAL', 'TIERS', 'SAFER_PLAY', 'KYC']);
      assert.equal(summary.isRestricted, true);
    });

    it('redacts sensitive field paths in formatted diff values', () => {
      assert.equal(formatConfigFieldValue('super-secret', 'text', 'provider.secretKey'), '[REDACTED]');
      assert.equal(formatConfigFieldValue('tok-123', 'text', 'auth.apiToken'), '[REDACTED]');
    });
  });

  describe('Permission Matrix & Domain Proposal Guards (RBAC)', () => {
    const makeUser = (role: AdminRole): AdminProfileResponse => ({
      id: `user-${role}`,
      email: `${role.toLowerCase()}@draughtbet.com`,
      username: role.toLowerCase(),
      fullName: role,
      roles: [role],
      permissions: []
    });

    it('synchronizes all 12 Phase 4 permissions across the 6 admin roles', () => {
      assert.equal(roleHasPermission('SUPER_ADMIN', PERMISSIONS.CONFIG_ACTIVATE), true);
      assert.equal(roleHasPermission('SUPER_ADMIN', PERMISSIONS.FLAGS_MANAGE), true);
      assert.equal(roleHasPermission('SUPER_ADMIN', PERMISSIONS.TEMPLATES_MANAGE), true);
      assert.equal(roleHasPermission('SUPER_ADMIN', PERMISSIONS.MAINTENANCE_MANAGE), true);

      assert.equal(roleHasPermission('FINANCE', PERMISSIONS.CONFIG_READ), true);
      assert.equal(roleHasPermission('FINANCE', PERMISSIONS.CONFIG_PROPOSE_FINANCIAL), true);
      assert.equal(roleHasPermission('FINANCE', PERMISSIONS.CONFIG_APPROVE), true);
      assert.equal(roleHasPermission('FINANCE', PERMISSIONS.CONFIG_ACTIVATE), false);

      assert.equal(roleHasPermission('RISK_COMPLIANCE', PERMISSIONS.CONFIG_PROPOSE_COMPLIANCE), true);
      assert.equal(roleHasPermission('RISK_COMPLIANCE', PERMISSIONS.FLAGS_KILLSWITCH), true);
      assert.equal(roleHasPermission('RISK_COMPLIANCE', PERMISSIONS.FLAGS_MANAGE), false);

      assert.equal(roleHasPermission('GAME_OPERATIONS', PERMISSIONS.CONFIG_PROPOSE_GAME), true);
      assert.equal(roleHasPermission('GAME_OPERATIONS', PERMISSIONS.FLAGS_KILLSWITCH), true);
      assert.equal(roleHasPermission('GAME_OPERATIONS', PERMISSIONS.CONFIG_APPROVE), false);

      assert.equal(roleHasPermission('SUPPORT', PERMISSIONS.FLAGS_READ), true);
      assert.equal(roleHasPermission('SUPPORT', PERMISSIONS.MAINTENANCE_READ), true);
      assert.equal(roleHasPermission('SUPPORT', PERMISSIONS.CONFIG_READ), false);

      assert.equal(roleHasPermission('READ_ONLY_AUDITOR', PERMISSIONS.CONFIG_READ), true);
      assert.equal(roleHasPermission('READ_ONLY_AUDITOR', PERMISSIONS.FLAGS_READ), true);
      assert.equal(roleHasPermission('READ_ONLY_AUDITOR', PERMISSIONS.MAINTENANCE_READ), true);
      assert.equal(roleHasPermission('READ_ONLY_AUDITOR', PERMISSIONS.CONFIG_APPROVE), false);
      assert.equal(rolesHavePermission(['READ_ONLY_AUDITOR'], PERMISSIONS.FLAGS_MANAGE), false);
    });

    it('enforces domain-scoped proposal permissions accurately', () => {
      const superAdmin = makeUser('SUPER_ADMIN');
      const finance = makeUser('FINANCE');
      const gameOps = makeUser('GAME_OPERATIONS');
      const compliance = makeUser('RISK_COMPLIANCE');
      const auditor = makeUser('READ_ONLY_AUDITOR');
      const support = makeUser('SUPPORT');

      // SUPER_ADMIN can propose all domains
      const allDomains: ConfigDomainName[] = [
        'PLATFORM',
        'FINANCIAL',
        'TIERS',
        'GAME',
        'MATCHMAKING',
        'SAFER_PLAY',
        'KYC'
      ];
      for (const dom of allDomains) {
        assert.equal(canProposeDomain(superAdmin, dom), true);
      }

      // FINANCE can propose FINANCIAL, TIERS, PLATFORM only
      assert.equal(canProposeDomain(finance, 'FINANCIAL'), true);
      assert.equal(canProposeDomain(finance, 'TIERS'), true);
      assert.equal(canProposeDomain(finance, 'PLATFORM'), true);
      assert.equal(canProposeDomain(finance, 'GAME'), false);
      assert.equal(canProposeDomain(finance, 'KYC'), false);

      // GAME_OPERATIONS can propose GAME, MATCHMAKING, PLATFORM only
      assert.equal(canProposeDomain(gameOps, 'GAME'), true);
      assert.equal(canProposeDomain(gameOps, 'MATCHMAKING'), true);
      assert.equal(canProposeDomain(gameOps, 'PLATFORM'), true);
      assert.equal(canProposeDomain(gameOps, 'FINANCIAL'), false);

      // RISK_COMPLIANCE can propose SAFER_PLAY, KYC, PLATFORM only
      assert.equal(canProposeDomain(compliance, 'SAFER_PLAY'), true);
      assert.equal(canProposeDomain(compliance, 'KYC'), true);
      assert.equal(canProposeDomain(compliance, 'PLATFORM'), true);
      assert.equal(canProposeDomain(compliance, 'FINANCIAL'), false);

      // READ_ONLY_AUDITOR and SUPPORT cannot propose any domain
      assert.equal(canProposeAnyConfig(auditor), false);
      assert.equal(canProposeAnyConfig(support), false);
      assert.equal(canAccessPermission(auditor, PERMISSIONS.CONFIG_READ), true);
      assert.equal(canAccessPermission(support, PERMISSIONS.CONFIG_READ), false);
    });
  });

  describe('Admin API Client Integration (Config, Approvals, Flags, Templates, Maintenance)', () => {
    let calls: Array<{
      url: string;
      method: string;
      body: Record<string, unknown> | null;
      headers: unknown;
    }> = [];

    beforeEach(() => {
      calls = [];
      apiClient.setSessionMetadata({
        csrfToken: 'test-nonce.test-sig',
        expiresIn: 900
      });
    });

    const mockFetchOnce = (status: number, responseBody: unknown) => {
      globalThis.fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
        calls.push({
          url: String(url),
          method: options.method || 'GET',
          body: typeof options.body === 'string' ? (JSON.parse(options.body) as Record<string, unknown>) : null,
          headers: options.headers
        });
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          json: async () => responseBody
        } as unknown as Response;
      }) as typeof fetch;
    };

    it('loads active configuration, creates draft, validates, submits, approves, and activates', async () => {
      // 1. Load active config
      mockFetchOnce(200, {
        config: {
          id: 'cfg-1',
          version: 1,
          status: 'ACTIVE',
          checksum: 'a'.repeat(64),
          payload: DEFAULT_CONFIG_PAYLOAD
        }
      });
      const active = await adminApi.getActiveConfig();
      assert.equal(active.config.version, 1);
      assert.match(calls[0].url, /\/admin\/config\/active$/);

      // 2. Validate draft payload
      mockFetchOnce(200, {
        valid: true,
        checksum: 'b'.repeat(64),
        isRestricted: true,
        modifiedDomains: ['FINANCIAL']
      });
      const valRes = await adminApi.validateConfigDraft(DEFAULT_CONFIG_PAYLOAD, 1);
      assert.equal(valRes.valid, true);
      assert.equal(valRes.isRestricted, true);

      // 3. Create draft
      mockFetchOnce(201, {
        draft: {
          id: 'draft-2',
          version: 2,
          status: 'DRAFT',
          checksum: 'b'.repeat(64),
          changeReason: 'Update rake commission'
        }
      });
      const created = await adminApi.createConfigDraft({
        changeReason: 'Update rake commission',
        baseVersion: 1,
        payload: DEFAULT_CONFIG_PAYLOAD
      });
      assert.equal(created.draft.version, 2);
      assert.equal(calls[2].method, 'POST');

      // 4. Submit draft -> PENDING_APPROVAL
      mockFetchOnce(200, {
        version: {
          id: 'draft-2',
          version: 2,
          status: 'PENDING_APPROVAL',
          checksum: 'b'.repeat(64)
        }
      });
      const submitted = await adminApi.submitConfigDraft('draft-2');
      assert.equal(submitted.version.status, 'PENDING_APPROVAL');

      // 5. Maker-Checker Approve with bound checksum
      mockFetchOnce(200, {
        version: { id: 'draft-2', version: 2, status: 'APPROVED', checksum: 'b'.repeat(64) },
        approval: { id: 'appr-1', status: 'APPROVED', checksum: 'b'.repeat(64) }
      });
      const approved = await adminApi.approveConfigVersion('draft-2', {
        reviewNote: 'Verified financial parameters',
        checksum: 'b'.repeat(64)
      });
      assert.equal(approved.version.status, 'APPROVED');
      assert.equal(calls[4].body?.checksum, 'b'.repeat(64));

      // 6. Atomic Activation
      mockFetchOnce(200, {
        version: { id: 'draft-2', version: 2, status: 'ACTIVE', checksum: 'b'.repeat(64) }
      });
      const activated = await adminApi.activateConfigVersion('draft-2');
      assert.equal(activated.version.status, 'ACTIVE');
    });

    it('handles rejection and non-destructive rollback', async () => {
      mockFetchOnce(200, {
        version: { id: 'ver-3', version: 3, status: 'REJECTED' },
        approval: { id: 'appr-2', status: 'REJECTED', reviewNote: 'Exceeds risk cap' }
      });
      const rej = await adminApi.rejectConfigVersion('ver-3', 'Exceeds risk cap');
      assert.equal(rej.version.status, 'REJECTED');

      mockFetchOnce(201, {
        version: { id: 'ver-4', version: 4, status: 'DRAFT', rolledBackFrom: 1 }
      });
      const rb = await adminApi.rollbackConfigVersion(1, 'Rollback to baseline v1');
      assert.equal(rb.version.version, 4);
      assert.equal(rb.version.rolledBackFrom, 1);
    });

    it('manages feature flags, kill switches, and deterministic cohort evaluation', async () => {
      mockFetchOnce(200, {
        flags: [
          {
            id: 'ff-1',
            key: 'live_matchmaking_queue',
            name: 'Live Matchmaking Queue',
            enabled: true,
            rolloutPercentage: 100,
            isKillSwitch: true
          }
        ],
        count: 1
      });
      const list = await adminApi.getFeatureFlags({ isKillSwitch: true });
      assert.equal(list.flags.length, 1);

      mockFetchOnce(200, {
        flag: { id: 'ff-1', key: 'live_matchmaking_queue', enabled: false, isKillSwitch: true }
      });
      const tripped = await adminApi.triggerFeatureFlagKillSwitch('live_matchmaking_queue', {
        enabled: false,
        reason: 'Emergency halt during latency spike'
      });
      assert.equal(tripped.flag.enabled, false);

      mockFetchOnce(200, {
        evaluation: {
          key: 'enhanced_match_replay_viewer',
          enabled: true,
          reason: 'ROLLOUT_COHORT_MATCH',
          rolloutPercentage: 50,
          bucket: 18,
          grantsPermissions: false,
          rbacAuthoritative: true
        }
      });
      const evalRes = await adminApi.evaluateFeatureFlag('enhanced_match_replay_viewer', {
        userId: 'player-1',
        userTier: 'MASTER'
      });
      assert.equal(evalRes.evaluation.enabled, true);
      assert.equal(evalRes.evaluation.grantsPermissions, false);
      assert.equal(evalRes.evaluation.rbacAuthoritative, true);
    });

    it('manages notification templates and server-rendered previews', async () => {
      mockFetchOnce(200, {
        preview: {
          code: 'DEPOSIT_CONFIRMED',
          version: 1,
          renderedTitle: 'Deposit Confirmed',
          renderedBody: 'Your deposit of ₦25,000.00 has been credited.',
          requiredVariables: ['amount'],
          usedVariables: ['amount'],
          channels: ['IN_APP'],
          channelDetails: [{ channel: 'IN_APP', implemented: true, deliveryMode: 'POSTGRES_AND_SOCKET_OUTBOX', description: '' }]
        }
      });

      const prev = await adminApi.previewSavedNotificationTemplate('DEPOSIT_CONFIRMED', {
        amount: '₦25,000.00'
      });
      assert.equal(prev.preview.renderedBody, 'Your deposit of ₦25,000.00 has been credited.');
    });

    it('manages maintenance mode enable, disable, emergency reset, and access evaluation', async () => {
      mockFetchOnce(200, {
        maintenance: {
          id: 'singleton',
          active: true,
          effectivelyActive: true,
          effectiveStatus: 'ACTIVE',
          scope: 'GAMEPLAY_ONLY',
          headline: 'Game Server Maintenance',
          message: 'Gameplay will resume shortly.',
          allowedIps: [],
          allowedRoles: ['SUPER_ADMIN'],
          startsAt: null,
          endsAt: null,
          exemptPrefixes: ['/api/v1/auth', '/api/v1/admin'],
          restrictedPrefixes: ['/api/v1/matches']
        }
      });
      const enabled = await adminApi.enableMaintenance({
        scope: 'GAMEPLAY_ONLY',
        reason: 'Upgrade game server nodes'
      });
      assert.equal(enabled.maintenance.effectivelyActive, true);
      assert.equal(enabled.maintenance.scope, 'GAMEPLAY_ONLY');

      mockFetchOnce(200, {
        maintenance: { id: 'singleton', active: false, effectivelyActive: false, effectiveStatus: 'INACTIVE' },
        recovered: true
      });
      const reset = await adminApi.emergencyResetMaintenance('Emergency recovery');
      assert.equal(reset.recovered, true);
      assert.equal(reset.maintenance.active, false);
    });

    it('surfaces 403 permission errors cleanly as ApiError instances', async () => {
      mockFetchOnce(403, { error: 'Insufficient admin permission' });
      await assert.rejects(
        () => adminApi.activateConfigVersion('ver-2'),
        (err: unknown) => err instanceof ApiError && err.statusCode === 403
      );
    });
  });

  describe('UI Component Rendering & Navigation Verification', () => {
    it('renders ConfigDiffViewer with modified financial and game parameters, Maker-Checker badges, and Naira/kobo formatting', async () => {
      const { ConfigDiffViewer } = await import('../../../components/configuration/ConfigDiffViewer');

      const proposed = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      proposed.financial.commissionPercent = 15;
      proposed.tiers.AMATEUR.minStake = '75000'; // ₦750.00
      proposed.game.timeControlSeconds = 45;

      const html = renderToStaticMarkup(
        React.createElement(ConfigDiffViewer, {
          basePayload: DEFAULT_CONFIG_PAYLOAD,
          targetPayload: proposed,
          baseLabel: 'Active (v1)',
          targetLabel: 'Proposal (v2)'
        })
      );

      assert.match(html, /3 Changed/);
      assert.match(html, /Maker-Checker Required/);
      assert.match(html, /Platform Rake Commission/);
      assert.match(html, /10%/);
      assert.match(html, /15%/);
      assert.match(html, /₦750\.00 \(75,000 kobo\)/);
      assert.match(html, /Per-Turn Time Control/);
      assert.match(html, /45s/);
    });

    it('renders empty state when ConfigDiffViewer compares identical payloads', async () => {
      const { ConfigDiffViewer } = await import('../../../components/configuration/ConfigDiffViewer');

      const html = renderToStaticMarkup(
        React.createElement(ConfigDiffViewer, {
          basePayload: DEFAULT_CONFIG_PAYLOAD,
          targetPayload: DEFAULT_CONFIG_PAYLOAD
        })
      );

      assert.match(html, /No Configuration Differences Detected/);
    });

    it('defines and renders all 12 required Configuration navigation routes in ConfigSubNav', async () => {
      const { CONFIG_NAV_TABS, ConfigSubNav } = await import(
        '../../../components/configuration/ConfigSubNav'
      );
      const hrefs = CONFIG_NAV_TABS.map((t: { href: string }) => t.href);

      assert.deepEqual(hrefs, [
        '/configuration',
        '/configuration/platform',
        '/configuration/game',
        '/configuration/financial',
        '/configuration/kyc',
        '/configuration/safer-play',
        '/configuration/matchmaking',
        '/configuration/feature-flags',
        '/configuration/notifications',
        '/configuration/maintenance',
        '/configuration/versions',
        '/configuration/approvals'
      ]);

      const superAdminUser = {
        id: 'sa-1',
        email: 'sa@draughtbet.com',
        username: 'sa',
        fullName: 'Super Admin',
        roles: ['SUPER_ADMIN' as const],
        permissions: Object.values(PERMISSIONS)
      };
      const navHtml = renderToStaticMarkup(
        React.createElement(ConfigSubNav, { user: superAdminUser })
      );
      assert.match(navHtml, /Platform Settings/);
      assert.match(navHtml, /Financial Configuration/);
      assert.match(navHtml, /Feature Flags/);
      assert.match(navHtml, /Notification Templates/);
      assert.match(navHtml, /Maintenance/);
      assert.match(navHtml, /Version History/);
      assert.match(navHtml, /Approvals/);

      // Unauthenticated user renders zero restricted configuration tabs
      const anonHtml = renderToStaticMarkup(
        React.createElement(ConfigSubNav, { user: null })
      );
      assert.doesNotMatch(anonHtml, /Financial Configuration/);
      assert.doesNotMatch(anonHtml, /Approvals/);
    });
  });
});
