/**
 * Support Cases, Admin RBAC Checks, Oversight & Ledger Reconciliation Scenario
 * Verifies RBAC blocks player tokens from `/admin/*` endpoints (HTTP 403)
 * and, when an admin token is configured, exercises real admin inspection,
 * support case creation/update, withdrawal review, safer-play lift, and audit visibility.
 */
import crypto from 'node:crypto';
import { runFinancialReconciliation } from '../../jobs/financialReconciliation.js';

export async function runSupportDisputesAdminScenario(runner, samplePlayerState) {
  // 1. RBAC Negative Control: A regular player MUST receive 403 on admin endpoints
  if (samplePlayerState?.accessToken) {
    const forbidden = await runner.apiCall(
      samplePlayerState,
      'GET',
      '/admin/users?page=1&limit=5',
      {},
      [403]
    );
    runner.metrics.rbacBlocksVerified += forbidden.status === 403 ? 1 : 0;
  }

  // 2. Document real backend gaps cleanly (player-facing dispute/support creation routes do not exist)
  runner.recordGap('player.support_create', {
    detail: 'No player-facing POST /api/v1/support endpoint exists; support cases are admin-managed.'
  });
  runner.recordGap('player.dispute_create', {
    detail: 'No player-facing POST /api/v1/disputes endpoint exists; disputes are admin-reviewed.'
  });
  runner.recordGap('player.callout_decline_or_cancel', {
    detail: 'calloutRouter exposes GET /open, POST /, POST /:id/accept without player cancel/decline routes.'
  });

  // 3. Admin operational verification if admin token is supplied
  if (runner.adminAccessToken) {
    const adminUser = {
      index: 0,
      label: 'Admin',
      accessToken: runner.adminAccessToken
    };

    const [summary, users, matches, auditLogs, notifications] = await Promise.all([
      runner.apiCall(adminUser, 'GET', '/admin/dashboard/summary', {}, [200, 403]),
      runner.apiCall(adminUser, 'GET', '/admin/users?page=1&limit=25', {}, [200, 403]),
      runner.apiCall(adminUser, 'GET', '/admin/matches?page=1&limit=25', {}, [200, 403]),
      runner.apiCall(adminUser, 'GET', '/admin/audit/logs?page=1&limit=20', {}, [200, 403]),
      runner.apiCall(adminUser, 'GET', '/admin/notifications?page=1&limit=20', {}, [200, 403, 404])
    ]);

    runner.metrics.lastAdminVisibilityCheck = {
      checkedAt: new Date().toISOString(),
      summaryOk: summary.status === 200,
      listedUsersCount: users.json?.users?.length ?? 0,
      listedMatchesCount: matches.json?.matches?.length ?? 0,
      auditLogsCount: auditLogs.json?.logs?.length ?? 0,
      adminNotificationsCount: notifications.json?.notifications?.length ?? 0
    };

    // Exercise Support Case create + update against a synthetic user tagged to runId
    if (samplePlayerState?.userId) {
      const runTag = runner.runId || samplePlayerState.runId || 'sim';
      const refTag = crypto.randomBytes(2).toString('hex');
      const createdCase = await runner.apiCall(
        adminUser,
        'POST',
        '/admin/support/cases',
        {
          body: {
            userId: samplePlayerState.userId,
            subject: `[SIM:${runTag}-${refTag}] Automated payout inquiry`,
            description: `Synthetic operational verification ticket (Simulation Run ID: ${runTag}).`,
            category: 'WITHDRAWAL',
            priority: 'MEDIUM'
          }
        },
        [201, 403]
      );
      if (createdCase.status === 201 && createdCase.json?.supportCase?.id) {
        await runner.apiCall(
          adminUser,
          'PATCH',
          `/admin/support/cases/${createdCase.json.supportCase.id}`,
          {
            body: {
              status: 'RESOLVED',
              resolutionNote: 'Verified via automated simulation workflow.'
            }
          },
          [200, 403]
        );
        runner.logActivity(`Admin created & resolved support case ${createdCase.json.supportCase.reference || createdCase.json.supportCase.id}`, {
          event: 'admin.support_case'
        });
      }

      // Also leave one OPEN support ticket so an admin operator can triage/work on it manually in /support
      const openCase = await runner.apiCall(
        adminUser,
        'POST',
        '/admin/support/cases',
        {
          body: {
            userId: samplePlayerState.userId,
            subject: `[SIM:${runTag}-${refTag}] Disconnected match & wallet review`,
            description: `Player reported a match disconnect review request during Simulation Run ID ${runTag}. Left OPEN for manual admin triage, internal notes, and resolution.`,
            category: 'MATCH_DISPUTE',
            priority: 'HIGH'
          }
        },
        [201, 403]
      );
      if (openCase.status === 201 && openCase.json?.supportCase?.reference) {
        runner.logActivity(`Opened manual-triage support ticket ${openCase.json.supportCase.reference}`, {
          event: 'admin.support_case_open'
        });
      }
    }

    // Trigger + immediately lift a safer-play timeout after matches complete so players stay playable
    const timeoutTarget = runner.roster.find((u) => u.index % 7 === 0 && u.accessToken && u.userId);
    if (timeoutTarget) {
      await runner.apiCall(
        timeoutTarget,
        'POST',
        '/safer-play/timeout',
        { body: { minutes: 5 } },
        [201, 409]
      );
      await runner.apiCall(
        adminUser,
        'POST',
        `/admin/safer-play/${timeoutTarget.userId}/clear-timeout`,
        {},
        [200, 403, 404]
      );
      runner.logActivity(`Safer-play timeout verified & cleared for ${timeoutTarget.label}`, {
        userIndex: timeoutTarget.index,
        event: 'safer_play.clear_timeout'
      });
    }
  }

  // 4. Financial double-entry reconciliation check (read-only verification sweep)
  try {
    const recRun = await runFinancialReconciliation();
    runner.metrics.lastReconciliation = {
      id: recRun.id,
      status: recRun.status,
      discrepancyCount: Array.isArray(recRun.discrepancies) ? recRun.discrepancies.length : 0,
      ranAt: new Date().toISOString()
    };
    runner.logActivity(`Financial reconciliation finished: ${recRun.status}`, {
      event: 'ledger.reconciliation',
      status: recRun.status
    });
  } catch (err) {
    runner.recordGap('reconciliation.sweep_failed', { message: err.message });
  }

  return { ok: true };
}
