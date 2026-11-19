import prisma from '../utils/db.js';
import redis, { isRedisReady } from '../utils/redis.js';
import {
  SIM_EMAIL_DOMAIN,
  assertSafeSimulationEnvironment,
  createEphemeralSimPassword,
  createSimulationRunId,
  simEmail,
  simLabel,
  simUsername
} from './simGuard.js';

/**
 * Registers or authenticates a synthetic simulation identity via the real Auth API.
 * Each user receives an independent session, profile, eligibility record, and device fingerprint
 * tagged to the active simulation run ID.
 */
export async function ensureSyntheticUserSession(runner, userState) {
  const { index, email, username, password, deviceFingerprint, runId } = userState;
  const label = simLabel(index);

  const geo = await runner.apiCall(userState, 'POST', '/auth/geo-locate', {
    body: { lat: 6.5244, lng: 3.3792 }
  });
  let geoRes = geo;
  if (!geoRes.json?.binding) {
    geoRes = await runner.apiCall(userState, 'POST', '/auth/geo-locate', {
      body: { lat: 6.5244, lng: 3.3792 }
    });
  }
  if (!geoRes.json?.binding) {
    throw new Error(`${label} geo-locate did not return a binding token`);
  }

  // Try login first when resuming an existing roster user so we skip redundant 409 register calls
  const fastLogin = await runner.apiCall(
    userState,
    'POST',
    '/auth/login',
    {
      body: {
        email,
        password,
        fingerprintHash: deviceFingerprint,
        deviceInfo: {
          model: `SimDevice-${runId}-${String(index).padStart(2, '0')}`,
          os: 'SimOS 1.0',
          appVersion: '2.1.0'
        }
      }
    },
    [200, 401]
  );

  let tokens = null;
  if (fastLogin.status === 200 && fastLogin.json?.accessToken) {
    tokens = fastLogin.json;
  } else {
    let reg;
    for (let attempt = 0; attempt < 2; attempt++) {
      reg = await runner.apiCall(
        userState,
        'POST',
        '/auth/register',
        {
          body: {
            email,
            username,
            fullName: `Simulated Player ${String(index).padStart(2, '0')} [${runId}]`,
            dateOfBirth: '1996-06-15',
            countryCode: (geoRes.json?.countryCode || 'NG').toUpperCase(),
            geoBinding: geoRes.json?.binding,
            fingerprintHash: deviceFingerprint,
            password,
            deviceInfo: {
              model: `SimDevice-${runId}-${String(index).padStart(2, '0')}`,
              os: 'SimOS 1.0',
              appVersion: '2.1.0'
            }
          }
        },
        [201, 409]
      );
      if (reg.status === 201 || reg.status === 409) break;
    }

    if (reg.status === 201) {
      tokens = reg.json;
      if (index <= 25) runner.logActivity(`${label} registered [${runId}]`, { userIndex: index, event: 'auth.register' });
    } else {
      const login = await runner.apiCall(userState, 'POST', '/auth/login', {
        body: {
          email,
          password,
          fingerprintHash: deviceFingerprint,
          deviceInfo: {
            model: `SimDevice-${runId}-${String(index).padStart(2, '0')}`,
            os: 'SimOS 1.0',
            appVersion: '2.1.0'
          }
        }
      });
      if (login.status !== 200 || !login.json?.accessToken) {
        throw new Error(`${label} failed login after 409 conflict (HTTP ${login.status})`);
      }
      tokens = login.json;
      if (index <= 25) runner.logActivity(`${label} authenticated [${runId}]`, { userIndex: index, event: 'auth.login' });
    }
  }

  userState.accessToken = tokens.accessToken;
  userState.refreshToken = tokens.refreshToken;
  userState.online = true;

  const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));
  userState.userId = payload.userId;

  return userState;
}

export function buildSyntheticRoster(userCount, runId = createSimulationRunId(), sharedPasswordOverride = null) {
  const sharedRunPassword =
    typeof sharedPasswordOverride === 'string' && sharedPasswordOverride.length >= 8
      ? sharedPasswordOverride
      : createEphemeralSimPassword();
  const amateurCutoff = Math.ceil(userCount * 0.4);
  const masterCutoff = Math.ceil(userCount * 0.7);
  return Array.from({ length: userCount }, (_, i) => {
    const index = i + 1;
    const targetTier = index <= amateurCutoff ? 'AMATEUR' : index <= masterCutoff ? 'MASTER' : 'PRO';
    return {
      runId,
      index,
      label: simLabel(index),
      email: simEmail(index, runId),
      username: simUsername(index, runId),
      password: sharedRunPassword,
      targetTier,
      userId: null,
      accessToken: null,
      refreshToken: null,
      deviceFingerprint: `sim-fp-${runId}-${String(index).padStart(3, '0')}`,
      online: false,
      socketConnected: false,
      currentActivity: 'IDLE',
      currentMatchId: null,
      completedWorkflows: 0,
      failedWorkflows: 0,
      lastLatencyMs: null,
      lastError: null
    };
  });
}

/**
 * Promotes strictly this run's synthetic `@draughtbet.sim` users into AMATEUR/MASTER/PRO
 * tiers so high-stakes matchmaking presets and high-roller P2P callouts can execute.
 */
export async function applySyntheticTiersForRun(roster) {
  assertSafeSimulationEnvironment();
  if (!Array.isArray(roster) || roster.length === 0) return { masterCount: 0, proCount: 0 };

  const runId = roster[0]?.runId;
  if (!runId) return { masterCount: 0, proCount: 0 };

  const emailPrefix = `sim+${String(runId).toLowerCase()}.`;
  const masterIds = roster.filter((u) => u.userId && u.targetTier === 'MASTER').map((u) => u.userId);
  const proIds = roster.filter((u) => u.userId && u.targetTier === 'PRO').map((u) => u.userId);

  let masterCount = 0;
  let proCount = 0;

  if (masterIds.length > 0) {
    const res = await prisma.user.updateMany({
      where: {
        id: { in: masterIds },
        email: { startsWith: emailPrefix, endsWith: SIM_EMAIL_DOMAIN }
      },
      data: { tier: 'MASTER' }
    });
    masterCount = res.count;
  }

  if (proIds.length > 0) {
    const res = await prisma.user.updateMany({
      where: {
        id: { in: proIds },
        email: { startsWith: emailPrefix, endsWith: SIM_EMAIL_DOMAIN }
      },
      data: { tier: 'PRO' }
    });
    proCount = res.count;
  }

  return { masterCount, proCount };
}

/**
 * Strictly run-scoped cleanup: removes ONLY records owned by the specified `runId`
 * (`sim+<runId>.uXX@draughtbet.sim`). Refuses to execute without an explicit `runId`,
 * preserves all pre-existing users, wallets, system/unrelated ledger records,
 * reconciliation history (`FinancialReconciliationRun`), and unrelated admin audit logs.
 */
export async function resetSimulationFixtures({ runId } = {}) {
  assertSafeSimulationEnvironment();

  const normalizedRunId = typeof runId === 'string' ? runId.trim().toLowerCase() : '';
  if (!normalizedRunId || !/^[a-z0-9_-]{4,32}$/.test(normalizedRunId)) {
    throw new Error('resetSimulationFixtures requires a valid explicit runId to prevent unscoped deletions.');
  }

  const emailPrefix = `sim+${normalizedRunId}.`;
  const simUsers = await prisma.user.findMany({
    where: {
      AND: [
        { email: { startsWith: emailPrefix } },
        { email: { endsWith: SIM_EMAIL_DOMAIN } }
      ]
    },
    select: { id: true, email: true }
  });
  const userIds = simUsers.map((u) => u.id);
  const userIdSet = new Set(userIds);

  if (userIds.length === 0) {
    return { runId: normalizedRunId, removedUsers: 0, removedMatches: 0, removedTransactions: 0 };
  }

  // Only select matches where BOTH participants belong exclusively to this runId
  const candidateMatches = await prisma.match.findMany({
    where: {
      OR: [{ playerLightId: { in: userIds } }, { playerDarkId: { in: userIds } }]
    },
    select: { id: true, playerLightId: true, playerDarkId: true }
  });
  const matchIds = candidateMatches
    .filter((m) => userIdSet.has(m.playerLightId) && userIdSet.has(m.playerDarkId))
    .map((m) => m.id);

  if (isRedisReady(redis)) {
    for (const mId of matchIds) {
      await redis.del(`match:${mId}`).catch(() => { });
    }
    for (const uId of userIds) {
      await redis.del(`user:${uId}:activeMatch`).catch(() => { });
    }
  }

  let removedTransactions = 0;

  await prisma.$transaction(
    async (tx) => {
      const userAccounts = await tx.ledgerAccount.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
      });
      const accountIds = userAccounts.map((a) => a.id);

      const entryTxRows = accountIds.length
        ? await tx.ledgerEntry.findMany({
          where: { accountId: { in: accountIds } },
          select: { transactionId: true },
          distinct: ['transactionId']
        })
        : [];
      const candidateTxIds = [...new Set(entryTxRows.map((e) => e.transactionId))];

      // Filter strictly to balanced transactions whose non-system user legs belong exclusively to this runId
      const safeTxIds = [];
      if (candidateTxIds.length > 0) {
        const txEntries = await tx.ledgerEntry.findMany({
          where: { transactionId: { in: candidateTxIds } },
          include: { account: { select: { userId: true } } }
        });
        const entriesByTx = new Map();
        for (const entry of txEntries) {
          if (!entriesByTx.has(entry.transactionId)) entriesByTx.set(entry.transactionId, []);
          entriesByTx.get(entry.transactionId).push(entry);
        }
        for (const [txId, entries] of entriesByTx.entries()) {
          const touchesForeignUser = entries.some(
            (e) => e.account?.userId !== null && e.account?.userId !== undefined && !userIdSet.has(e.account.userId)
          );
          const netSum = entries.reduce((acc, e) => acc + BigInt(e.amountMinorUnits), 0n);
          if (!touchesForeignUser && netSum === 0n) {
            safeTxIds.push(txId);
          }
        }
      }

      removedTransactions = safeTxIds.length;
      if (safeTxIds.length > 0) {
        await tx.ledgerEntry.deleteMany({ where: { transactionId: { in: safeTxIds } } });
        await tx.ledgerTransaction.deleteMany({ where: { id: { in: safeTxIds } } });
      }

      if (matchIds.length > 0) {
        await tx.disputeEvidence.deleteMany({ where: { case: { matchId: { in: matchIds } } } });
        await tx.disputeCase.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchMove.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchParticipant.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.stakeReservation.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchReceipt.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchSettlement.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchGameState.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.gameEvent.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.gameStateSnapshot.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.matchConnectionEvent.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.gameOutbox.deleteMany({ where: { matchId: { in: matchIds } } });
        await tx.match.deleteMany({ where: { id: { in: matchIds } } });
      }

      const wallets = await tx.wallet.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
      });
      const walletIds = wallets.map((w) => w.id);

      await tx.supportCaseNote.deleteMany({ where: { case: { userId: { in: userIds } } } });
      await tx.supportCase.deleteMany({ where: { userId: { in: userIds } } });
      await tx.verificationCheck.deleteMany({ where: { case: { userId: { in: userIds } } } });
      await tx.verificationChallenge.deleteMany({ where: { userId: { in: userIds } } });
      await tx.verificationCase.deleteMany({ where: { userId: { in: userIds } } });
      await tx.outboxEvent.deleteMany({
        where: {
          OR: [{ aggregateId: { in: userIds } }, ...(walletIds.length > 0 ? [{ aggregateId: { in: walletIds } }] : [])]
        }
      });
      await tx.adminAuditLog.deleteMany({ where: { targetId: { in: userIds } } });
      await tx.adminRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
      await tx.saferPlayEvent.deleteMany({ where: { userId: { in: userIds } } });
      await tx.saferPlayProfile.deleteMany({ where: { userId: { in: userIds } } });
      await tx.riskEvent.deleteMany({ where: { userId: { in: userIds } } });
      await tx.riskCase.deleteMany({ where: { subjectId: { in: userIds } } });
      await tx.securityEvent.deleteMany({ where: { userId: { in: userIds } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.depositIntent.deleteMany({ where: { userId: { in: userIds } } });
      await tx.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
      await tx.withdrawalRequest.deleteMany({ where: { userId: { in: userIds } } });
      await tx.bankAccount.deleteMany({ where: { userId: { in: userIds } } });
      await tx.callout.deleteMany({
        where: { OR: [{ challengerId: { in: userIds } }, { acceptedBy: { in: userIds } }] }
      });
      await tx.deviceFingerprint.deleteMany({ where: { userId: { in: userIds } } });
      await tx.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
      await tx.userSession.deleteMany({ where: { userId: { in: userIds } } });
      await tx.eligibility.deleteMany({ where: { userId: { in: userIds } } });
      if (accountIds.length > 0) {
        await tx.ledgerAccount.deleteMany({ where: { id: { in: accountIds } } });
      }
      await tx.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    },
    { timeout: 60_000 }
  );

  return {
    runId: normalizedRunId,
    removedUsers: userIds.length,
    removedMatches: matchIds.length,
    removedTransactions
  };
}
