/**
 * Configurable Multi-User Simulation Orchestrator
 * Coordinates independent synthetic users interacting with real HTTP routes,
 * Socket.IO gameplay, webhooks, and admin verification sweeps with unique per-run
 * tagging (`runId`) and read-only ledger anomaly delta reporting.
 */
import prisma from '../utils/db.js';
import { assertSafeSimulationEnvironment, createSimulationRunId } from './simGuard.js';
import { applySyntheticTiersForRun, buildSyntheticRoster, ensureSyntheticUserSession, resetSimulationFixtures } from './identityManager.js';
import { runAuthProfileScenario } from './scenarios/authProfileScenario.js';
import { runWalletFinancialScenario } from './scenarios/walletFinancialScenario.js';
import { runMatchmakingWave } from './scenarios/matchmakingGameplayScenario.js';
import { runComplianceNotificationsScenario } from './scenarios/complianceNotificationsScenario.js';
import { runSupportDisputesAdminScenario } from './scenarios/supportDisputesAdminScenario.js';

const MAX_ACTIVITY_FEED = 120;
const MAX_LATENCY_SAMPLES = 500;

export const DEFAULT_SIMULATION_CONFIG = Object.freeze({
  userCount: 20,
  concurrency: 5,
  durationMs: 60_000,
  actionIntervalMs: 600,
  scenarios: ['auth', 'compliance', 'wallet', 'matchmaking', 'admin']
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureLedgerAnomalySnapshot() {
  try {
    if (!prisma?.ledgerEntry?.groupBy) return null;
    const grouped = await prisma.ledgerEntry.groupBy({
      by: ['transactionId'],
      _sum: { amountMinorUnits: true },
      _count: { _all: true }
    });
    const unbalanced = grouped
      .filter((g) => BigInt(g._sum.amountMinorUnits ?? 0) !== 0n || g._count._all < 2)
      .map((g) => ({
        transactionId: g.transactionId,
        netMinorUnits: String(g._sum.amountMinorUnits ?? 0),
        entryCount: g._count._all
      }));
    const emptyTxCount = await prisma.ledgerTransaction.count({
      where: { entries: { none: {} } }
    });
    return {
      capturedAt: new Date().toISOString(),
      totalTransactionsChecked: grouped.length,
      unbalancedTransactions: unbalanced,
      emptyTransactionsCount: emptyTxCount
    };
  } catch (err) {
    return { capturedAt: new Date().toISOString(), error: err.message };
  }
}

export class SimulationRunner {
  constructor({ fetchImpl = globalThis.fetch, baseOrigin } = {}) {
    this.fetch = fetchImpl;
    this.baseOrigin = (baseOrigin || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    this.lastRunId = null;
    this.resetInternalState();
  }

  resetInternalState() {
    this.status = 'IDLE'; // IDLE | RUNNING | PAUSED | STOPPING | STOPPED | COMPLETED | FAILED
    this.runId = null;
    this.config = { ...DEFAULT_SIMULATION_CONFIG };
    this.roster = [];
    this.adminAccessToken = null;
    this.startedAt = null;
    this.endedAt = null;
    this.lastError = null;
    this.pausePromise = null;
    this.pauseResolve = null;
    this.abortController = null;
    this.runLoopPromise = null;
    this.activityFeed = [];
    this.latencies = [];
    this.gaps = {};
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      unexpectedStatuses: 0,
      matchesCompleted: 0,
      movesPlayed: 0,
      rbacBlocksVerified: 0,
      lastReconciliation: null,
      lastAdminVisibilityCheck: null,
      ledgerAnomalyReport: null
    };
  }

  logActivity(message, meta = {}) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      message,
      ...meta
    };
    this.activityFeed.unshift(entry);
    if (this.activityFeed.length > MAX_ACTIVITY_FEED) {
      this.activityFeed.length = MAX_ACTIVITY_FEED;
    }
  }

  recordGap(key, info) {
    if (!this.gaps[key]) {
      this.gaps[key] = { count: 0, ...info };
    }
    this.gaps[key].count += 1;
  }

  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) {
      this.latencies.shift();
    }
  }

  async waitIfPaused() {
    while (this.status === 'PAUSED' && this.pausePromise) {
      await this.pausePromise;
    }
  }

  async refreshUserSession(userState) {
    if (!userState || userState.index === 0) return false;
    if (userState._refreshPromise) return userState._refreshPromise;

    userState._refreshPromise = (async () => {
      try {
        if (userState.refreshToken && userState.userId) {
          const res = await this.fetch(`${this.baseOrigin}/api/v1/auth/refresh`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-app-version': '2.1.0',
              ...(userState.username ? { 'x-sim-user': userState.username } : {})
            },
            body: JSON.stringify({
              userId: userState.userId,
              refreshToken: userState.refreshToken,
              deviceInfo: {
                model: `SimDevice-${userState.runId}-${String(userState.index).padStart(2, '0')}`,
                os: 'SimOS 1.0',
                appVersion: '2.1.0'
              }
            }),
            signal: this.abortController?.signal
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.accessToken) {
              userState.accessToken = data.accessToken;
              if (data.refreshToken) userState.refreshToken = data.refreshToken;
              return true;
            }
          }
        }

        if (userState.email && userState.password) {
          const loginRes = await this.fetch(`${this.baseOrigin}/api/v1/auth/login`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-app-version': '2.1.0',
              ...(userState.username ? { 'x-sim-user': userState.username } : {})
            },
            body: JSON.stringify({
              email: userState.email,
              password: userState.password,
              fingerprintHash: userState.deviceFingerprint
            }),
            signal: this.abortController?.signal
          });
          if (loginRes.ok) {
            const data = await loginRes.json();
            if (data?.accessToken) {
              userState.accessToken = data.accessToken;
              userState.refreshToken = data.refreshToken ?? userState.refreshToken;
              userState.online = true;
              return true;
            }
          }
        }
        return false;
      } catch {
        return false;
      } finally {
        userState._refreshPromise = null;
      }
    })();

    return userState._refreshPromise;
  }

  async rawRequest(userState, method, path, options = {}, retryOn401 = true) {
    await this.waitIfPaused();
    const {
      baseRoot = false,
      body,
      rawBody,
      headers = {},
      expectedStatuses = [200, 201]
    } = options;

    const url = baseRoot ? `${this.baseOrigin}${path}` : `${this.baseOrigin}/api/v1${path}`;
    const finalHeaders = {
      'x-app-version': '2.1.0',
      ...(userState?.username ? { 'x-sim-user': userState.username } : {}),
      ...headers
    };
    if (userState?.accessToken && !finalHeaders.authorization) {
      finalHeaders.authorization = `Bearer ${userState.accessToken}`;
    }

    let requestBody = rawBody;
    if (body !== undefined && rawBody === undefined) {
      finalHeaders['content-type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }

    const started = Date.now();
    this.metrics.totalRequests += 1;
    let res;
    let text = '';
    let json = null;

    try {
      res = await this.fetch(url, {
        method,
        headers: finalHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : requestBody,
        signal: this.abortController?.signal
      });

      if (
        res.status === 401 &&
        retryOn401 &&
        userState &&
        !path.startsWith('/auth/') &&
        (await this.refreshUserSession(userState))
      ) {
        return this.rawRequest(userState, method, path, options, false);
      }

      const elapsed = Date.now() - started;
      this.recordLatency(elapsed);
      if (userState) userState.lastLatencyMs = elapsed;

      text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (expectedStatuses.includes(res.status)) {
        this.metrics.successfulRequests += 1;
      } else {
        this.metrics.unexpectedStatuses += 1;
        this.metrics.failedRequests += 1;
        if (userState) {
          userState.failedWorkflows += 1;
          userState.lastError = `${method} ${path} -> HTTP ${res.status}: ${json?.error || text.slice(0, 120)}`;
        }
      }

      return { status: res.status, json, text };
    } catch (err) {
      this.metrics.failedRequests += 1;
      if (userState && err.name !== 'AbortError') {
        userState.failedWorkflows += 1;
        userState.lastError = `${method} ${path}: ${err.message}`;
      }
      throw err;
    }
  }

  apiCall(userState, method, path, options = {}, expectedStatuses = [200, 201]) {
    return this.rawRequest(userState, method, path, { ...options, expectedStatuses });
  }

  configure(partial = {}) {
    const userCount = Math.min(Math.max(Number(partial.userCount ?? this.config.userCount) || 20, 2), 1000);
    const concurrency = Math.min(Math.max(Number(partial.concurrency ?? this.config.concurrency) || 5, 1), Math.min(userCount, 30));
    const durationMs = Math.min(Math.max(Number(partial.durationMs ?? this.config.durationMs) || 60_000, 5_000), 1_800_000);
    const actionIntervalMs = Math.min(Math.max(Number(partial.actionIntervalMs ?? this.config.actionIntervalMs) || 600, 20), 10_000);
    const scenarios = Array.isArray(partial.scenarios) && partial.scenarios.length > 0
      ? partial.scenarios
      : this.config.scenarios;

    if (partial.baseOrigin) {
      this.baseOrigin = String(partial.baseOrigin).replace(/\/+$/, '');
    }
    if (partial.adminAccessToken !== undefined) {
      this.adminAccessToken = partial.adminAccessToken;
    }

    this.config = { userCount, concurrency, durationMs, actionIntervalMs, scenarios };
    return this.config;
  }

  async start(partialConfig = {}, { waitForCompletion = false } = {}) {
    assertSafeSimulationEnvironment();

    if (['RUNNING', 'PAUSED', 'STOPPING'].includes(this.status)) {
      const err = new Error(`Simulation is already ${this.status}`);
      err.status = 409;
      throw err;
    }

    this.resetInternalState();
    this.configure(partialConfig);
    this.runId = partialConfig.runId || createSimulationRunId();
    this.lastRunId = this.runId;
    this.roster = buildSyntheticRoster(this.config.userCount, this.runId, partialConfig.simPassword);
    this.status = 'RUNNING';
    this.startedAt = new Date().toISOString();
    this.abortController = new AbortController();

    this.logActivity(
      `Simulation ${this.runId} started (${this.config.userCount} users, concurrency=${this.config.concurrency})`,
      { event: 'simulation.started' }
    );

    this.runLoopPromise = this.executeSimulationLoop().catch((err) => {
      if (err.name !== 'AbortError') {
        this.status = 'FAILED';
        this.lastError = err.message;
        this.logActivity(`Simulation ${this.runId} failed: ${err.message}`, { event: 'simulation.failed' });
      }
    }).finally(() => {
      this.endedAt = new Date().toISOString();
    });

    if (waitForCompletion) {
      await this.runLoopPromise;
      return this.generateReport();
    }
    return this.getStatus();
  }

  async runConcurrentBatches(items, workerFn) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(this.config.concurrency, queue.length) }, async () => {
      while (queue.length > 0 && this.status !== 'STOPPING' && this.status !== 'STOPPED') {
        await this.waitIfPaused();
        if (this.status === 'STOPPING' || this.status === 'STOPPED') break;
        const item = queue.shift();
        if (!item) break;
        try {
          await workerFn(item);
        } catch (err) {
          if (err.name !== 'AbortError') {
            this.logActivity(`Worker error: ${err.message}`, { event: 'simulation.worker_error' });
          }
        }
        await sleep(Math.max(50, Math.floor(this.config.actionIntervalMs / 2)));
      }
    });
    await Promise.all(workers);
  }

  async executeSimulationLoop() {
    const enabled = new Set(this.config.scenarios);

    const beforeSnapshot = await captureLedgerAnomalySnapshot();

    // Phase 1: Authenticate / register all synthetic identities cleanly (or fast-login if auth scenario omitted)
    if (enabled.has('auth')) {
      await this.runConcurrentBatches(this.roster, async (user) => {
        await runAuthProfileScenario(this, user);
      });
      const tiers = await applySyntheticTiersForRun(this.roster);
      this.logActivity(`Assigned simulation tiers (MASTER=${tiers.masterCount}, PRO=${tiers.proCount})`, {
        event: 'simulation.tiers_assigned',
        ...tiers
      });
    } else if (enabled.has('compliance') || enabled.has('wallet') || enabled.has('matchmaking')) {
      await this.runConcurrentBatches(this.roster, async (user) => {
        await ensureSyntheticUserSession(this, user);
      });
      const tiers = await applySyntheticTiersForRun(this.roster);
      this.logActivity(`Authenticated & assigned tiers for matchmaking (MASTER=${tiers.masterCount}, PRO=${tiers.proCount})`, {
        event: 'simulation.tiers_assigned',
        ...tiers
      });
    }

    // Phase 2: KYC verification & safer-play baseline setup
    if (enabled.has('compliance') && this.status === 'RUNNING') {
      await this.runConcurrentBatches(this.roster, async (user) => {
        await runComplianceNotificationsScenario(this, user);
      });
    }

    // Phase 3: Seed balances, linked bank accounts, and mock financial workflows
    if (enabled.has('wallet') && this.status === 'RUNNING') {
      await this.runConcurrentBatches(this.roster, async (user) => {
        await runWalletFinancialScenario(this, user);
      });
    }

    // Phase 4: Multi-round high-stakes Draughts gameplay (P2P callouts + tiered queue waves).
    if (enabled.has('matchmaking') && (this.status === 'RUNNING' || this.status === 'PAUSED')) {
      const gameplayDeadline = Date.now() + this.config.durationMs;
      let round = 0;
      const targetMinRounds = 2;
      while ((round < targetMinRounds || Date.now() < gameplayDeadline) && this.status !== 'STOPPING' && this.status !== 'STOPPED') {
        await this.waitIfPaused();
        if (this.status === 'STOPPING' || this.status === 'STOPPED') break;

        await runMatchmakingWave(this, this.roster, round);

        round += 1;
        if (round >= targetMinRounds && Date.now() + this.config.actionIntervalMs >= gameplayDeadline) break;
        await sleep(this.config.actionIntervalMs);
      }
    }

    // Phase 5: Admin oversight, RBAC enforcement check, support case + reconciliation (read-only)
    if (enabled.has('admin') && this.status !== 'STOPPING' && this.status !== 'STOPPED') {
      const sampleUser = this.roster.find((u) => Boolean(u.userId)) || this.roster[0];
      await runSupportDisputesAdminScenario(this, sampleUser);
    }

    const afterSnapshot = await captureLedgerAnomalySnapshot();
    if (beforeSnapshot && afterSnapshot && !beforeSnapshot.error && !afterSnapshot.error) {
      const beforeIds = new Set(beforeSnapshot.unbalancedTransactions.map((t) => t.transactionId));
      const newUnbalanced = afterSnapshot.unbalancedTransactions.filter(
        (t) => !beforeIds.has(t.transactionId)
      );
      this.metrics.ledgerAnomalyReport = {
        runId: this.runId,
        preExistingUnbalanced: beforeSnapshot.unbalancedTransactions,
        newlyIntroducedUnbalanced: newUnbalanced,
        totalTransactionsAfter: afterSnapshot.totalTransactionsChecked,
        emptyTransactionsAfter: afterSnapshot.emptyTransactionsCount,
        autoRepairsAttempted: 0
      };
    }

    if (this.status === 'STOPPING') {
      this.status = 'STOPPED';
      this.logActivity(`Simulation ${this.runId} stopped cleanly`, { event: 'simulation.stopped' });
    } else if (this.status !== 'FAILED') {
      this.status = 'COMPLETED';
      this.logActivity(`Simulation ${this.runId} completed all scenarios`, { event: 'simulation.completed' });
    }
  }

  pause() {
    if (this.status !== 'RUNNING') {
      return this.getStatus();
    }
    this.status = 'PAUSED';
    this.pausePromise = new Promise((resolve) => {
      this.pauseResolve = resolve;
    });
    this.logActivity('Simulation paused', { event: 'simulation.paused' });
    return this.getStatus();
  }

  resume() {
    if (this.status !== 'PAUSED') {
      return this.getStatus();
    }
    this.status = 'RUNNING';
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
      this.pausePromise = null;
    }
    this.logActivity('Simulation resumed', { event: 'simulation.resumed' });
    return this.getStatus();
  }

  async stop() {
    if (!['RUNNING', 'PAUSED'].includes(this.status)) {
      return this.getStatus();
    }
    this.status = 'STOPPING';
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
      this.pausePromise = null;
    }
    this.abortController?.abort();
    if (this.runLoopPromise) {
      await Promise.allSettled([this.runLoopPromise]);
    }
    if (this.status === 'STOPPING') {
      this.status = 'STOPPED';
    }
    return this.getStatus();
  }

  async resetFixtures(explicitRunId = null) {
    assertSafeSimulationEnvironment();
    const targetRunId = explicitRunId || this.runId || this.lastRunId;
    if (['RUNNING', 'PAUSED', 'STOPPING'].includes(this.status)) {
      await this.stop();
    }
    const summary = await resetSimulationFixtures({ runId: targetRunId });
    this.resetInternalState();
    this.logActivity(`Run-scoped reset completed for ${summary.runId} (removedUsers=${summary.removedUsers})`, {
      event: 'simulation.reset',
      ...summary
    });
    return summary;
  }

  getStatus() {
    const sortedLat = [...this.latencies].sort((a, b) => a - b);
    const avgLatencyMs = sortedLat.length
      ? Math.round(sortedLat.reduce((acc, v) => acc + v, 0) / sortedLat.length)
      : 0;
    const p95Index = sortedLat.length ? Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95)) : 0;
    const p95LatencyMs = sortedLat.length ? sortedLat[p95Index] : 0;

    return {
      status: this.status,
      runId: this.runId ?? this.lastRunId,
      config: this.config,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastError: this.lastError,
      metrics: {
        ...this.metrics,
        onlineUsers: this.roster.filter((u) => u.online).length,
        socketConnectedUsers: this.roster.filter((u) => u.socketConnected).length,
        avgLatencyMs,
        p95LatencyMs
      },
      roster: this.roster.map((u) => ({
        runId: u.runId,
        index: u.index,
        label: u.label,
        email: u.email,
        username: u.username,
        userId: u.userId,
        online: u.online,
        socketConnected: u.socketConnected,
        currentActivity: u.currentActivity,
        currentMatchId: u.currentMatchId,
        completedWorkflows: u.completedWorkflows,
        failedWorkflows: u.failedWorkflows,
        lastLatencyMs: u.lastLatencyMs,
        lastError: u.lastError
      })),
      activityFeed: this.activityFeed,
      gaps: this.gaps
    };
  }

  generateReport() {
    return {
      ...this.getStatus(),
      generatedAt: new Date().toISOString()
    };
  }
}

export const sharedSimulationRunner = new SimulationRunner();
