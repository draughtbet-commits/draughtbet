'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import type { SimulationStatusSnapshot } from '@/lib/api/types';
import { Card, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/lib/utils';
import {
  FlaskConical,
  Play,
  Pause,
  Square,
  RotateCcw,
  RefreshCw,
  ShieldCheck,
  Scale,
  AlertTriangle
} from 'lucide-react';

const STATUS_BADGE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info' | 'gold'> = {
  IDLE: 'default',
  RUNNING: 'gold',
  PAUSED: 'warning',
  STOPPING: 'warning',
  STOPPED: 'info',
  COMPLETED: 'success',
  FAILED: 'danger'
};

function SimulationLabPageContent() {
  const [sim, setSim] = useState<SimulationStatusSnapshot | null>(null);
  const [userCount, setUserCount] = useState(20);
  const [concurrency, setConcurrency] = useState(5);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [gateBlockedMessage, setGateBlockedMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await adminApi.getSimulationStatus();
      setSim(res.simulation);
      setGateBlockedMessage(null);
      setActionError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to reach simulation controller';
      if (msg.toLowerCase().includes('not found') || msg.includes('404') || msg.toLowerCase().includes('refused')) {
        setGateBlockedMessage(msg);
      } else {
        setActionError(msg);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    adminApi
      .getSimulationStatus()
      .then((res) => {
        if (!active) return;
        setSim(res.simulation);
        setGateBlockedMessage(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'Unable to reach simulation controller';
        setGateBlockedMessage(msg);
      });
    return () => {
      active = false;
    };
  }, []);

  const isRunning = sim?.status === 'RUNNING';
  const isPaused = sim?.status === 'PAUSED';
  const isActive = isRunning || isPaused || sim?.status === 'STOPPING';

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void fetchStatus();
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [isActive, fetchStatus]);

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setBusyAction(name);
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : `Action ${name} failed`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F5F7FA] tracking-tight flex items-center gap-2.5">
            <FlaskConical className="w-6 h-6 text-[#18C986]" />
            Platform Simulation Lab (Dev-Only)
          </h1>
          <p className="text-sm text-[#8FA3B7] mt-1">
            Orchestrate up to 20+ independent synthetic players across real HTTP routes, Socket.IO draughts matches, webhooks, and admin verification.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sim?.runId && (
            <Badge variant="info" size="md">
              Run: {sim.runId}
            </Badge>
          )}
          {sim && <Badge variant={STATUS_BADGE[sim.status] ?? 'default'} size="md">{sim.status}</Badge>}
          <Button variant="outline" size="sm" onClick={() => void fetchStatus()}>
            <RefreshCw className="w-4 h-4 mr-1.5" />
            Poll Now
          </Button>
        </div>
      </div>

      {gateBlockedMessage && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-sm">
              <div className="font-semibold text-amber-300">Simulation Controller Disabled in This Environment</div>
              <p className="text-[#8FA3B7]">
                {gateBlockedMessage}. Ensure the backend is started in an isolated local/dev environment with{' '}
                <code className="text-[#F5F7FA]">NODE_ENV=development</code>,{' '}
                <code className="text-[#F5F7FA]">SIMULATION_ENABLED=true</code>,{' '}
                <code className="text-[#F5F7FA]">SIMULATION_MOCK_PAYMENTS=true</code>, local PostgreSQL, and local Redis.
              </p>
            </div>
          </div>
        </Card>
      )}

      {actionError && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
          {actionError}
        </div>
      )}

      {/* Controls */}
      <Card>
        <CardTitle className="text-base mb-1">Runner Configuration &amp; Lifecycle Controls</CardTitle>
        <CardDescription className="mb-4">
          Strictly isolated to synthetic <code className="text-[#F5F7FA]">@draughtbet.sim</code> accounts. Reset deletes only simulation fixtures.
        </CardDescription>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <label className="block">
            <span className="text-xs text-[#8FA3B7] uppercase tracking-wider">Simulated Users</span>
            <input
              type="number"
              min={2}
              max={1000}
              disabled={isActive}
              value={userCount}
              onChange={(e) => setUserCount(Number(e.target.value) || 20)}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-[#08121E] border border-[#274056] text-sm text-[#F5F7FA]"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#8FA3B7] uppercase tracking-wider">Concurrency</span>
            <input
              type="number"
              min={1}
              max={30}
              disabled={isActive}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value) || 5)}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-[#08121E] border border-[#274056] text-sm text-[#F5F7FA]"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#8FA3B7] uppercase tracking-wider">Duration (seconds)</span>
            <input
              type="number"
              min={10}
              max={1800}
              disabled={isActive}
              value={durationSeconds}
              onChange={(e) => setDurationSeconds(Number(e.target.value) || 60)}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-[#08121E] border border-[#274056] text-sm text-[#F5F7FA]"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="primary"
            size="sm"
            disabled={isActive || busyAction !== null || Boolean(gateBlockedMessage)}
            onClick={() =>
              void runAction('start', async () => {
                const res = await adminApi.startSimulation({
                  userCount,
                  concurrency,
                  durationMs: durationSeconds * 1000
                });
                setSim(res.simulation);
              })
            }
          >
            <Play className="w-4 h-4 mr-1.5" />
            Start Simulation
          </Button>

          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('pause', async () => {
                  const res = await adminApi.pauseSimulation();
                  setSim(res.simulation);
                })
              }
            >
              <Pause className="w-4 h-4 mr-1.5" />
              Pause
            </Button>
          )}

          {isPaused && (
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('resume', async () => {
                  const res = await adminApi.resumeSimulation();
                  setSim(res.simulation);
                })
              }
            >
              <Play className="w-4 h-4 mr-1.5" />
              Resume
            </Button>
          )}

          {isActive && (
            <Button
              variant="danger"
              size="sm"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('stop', async () => {
                  const res = await adminApi.stopSimulation();
                  setSim(res.simulation);
                })
              }
            >
              <Square className="w-4 h-4 mr-1.5" />
              Stop
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={busyAction !== null || Boolean(gateBlockedMessage)}
            onClick={() =>
              void runAction('reconcile', async () => {
                await adminApi.runSimulationReconciliation();
                await fetchStatus();
              })
            }
          >
            <Scale className="w-4 h-4 mr-1.5" />
            Run Ledger Reconciliation
          </Button>

          <Button
            variant="ghost"
            size="sm"
            disabled={isActive || busyAction !== null || Boolean(gateBlockedMessage) || !sim?.runId}
            onClick={() =>
              void runAction('reset', async () => {
                const res = await adminApi.resetSimulation(sim?.runId);
                setSim(res.simulation);
              })
            }
          >
            <RotateCcw className="w-4 h-4 mr-1.5" />
            Reset Run Fixtures
          </Button>
        </div>
      </Card>

      {sim && (
        <>
          {/* Live KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <Card>
              <div className="text-xs text-[#8FA3B7] uppercase">Online Users</div>
              <div className="text-2xl font-bold text-[#F5F7FA] mt-1">
                {sim.metrics.onlineUsers} / {sim.config.userCount}
              </div>
              <div className="text-xs text-[#18C986] mt-1">
                {sim.metrics.socketConnectedUsers} Socket.IO active
              </div>
            </Card>
            <Card>
              <div className="text-xs text-[#8FA3B7] uppercase">HTTP Requests</div>
              <div className="text-2xl font-bold text-[#F5F7FA] mt-1">{sim.metrics.totalRequests}</div>
              <div className="text-xs text-[#8FA3B7] mt-1">
                {sim.metrics.successfulRequests} ok · {sim.metrics.failedRequests} failed
              </div>
            </Card>
            <Card>
              <div className="text-xs text-[#8FA3B7] uppercase">Matches &amp; Moves</div>
              <div className="text-2xl font-bold text-[#F5F7FA] mt-1">{sim.metrics.matchesCompleted}</div>
              <div className="text-xs text-[#8FA3B7] mt-1">{sim.metrics.movesPlayed} real moves</div>
            </Card>
            <Card>
              <div className="text-xs text-[#8FA3B7] uppercase">HTTP Latency</div>
              <div className="text-2xl font-bold text-[#F5F7FA] mt-1">{sim.metrics.avgLatencyMs}ms</div>
              <div className="text-xs text-[#8FA3B7] mt-1">P95: {sim.metrics.p95LatencyMs}ms</div>
            </Card>
            <Card>
              <div className="text-xs text-[#8FA3B7] uppercase">Ledger &amp; RBAC</div>
              <div className="text-lg font-bold text-[#F5F7FA] mt-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-[#18C986]" />
                {sim.metrics.lastReconciliation?.status ?? 'PENDING'}
              </div>
              <div className="text-xs text-[#8FA3B7] mt-1">
                {sim.metrics.rbacBlocksVerified} 403 RBAC check(s)
              </div>
            </Card>
          </div>

          {sim.metrics.ledgerAnomalyReport && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <CardTitle className="text-sm text-amber-300">
                  Read-Only Ledger Integrity Audit ({sim.metrics.ledgerAnomalyReport.runId})
                </CardTitle>
                <Badge
                  variant={
                    sim.metrics.ledgerAnomalyReport.newlyIntroducedUnbalanced.length === 0
                      ? 'success'
                      : 'danger'
                  }
                >
                  New Run Anomalies: {sim.metrics.ledgerAnomalyReport.newlyIntroducedUnbalanced.length}
                </Badge>
              </div>
              <div className="text-xs text-[#8FA3B7] space-y-1">
                <div>
                  Pre-existing unbalanced transactions preserved untouched:{' '}
                  <span className="text-[#F5F7FA] font-mono">
                    {sim.metrics.ledgerAnomalyReport.preExistingUnbalanced.length}
                  </span>{' '}
                  (total checked: {sim.metrics.ledgerAnomalyReport.totalTransactionsAfter}, auto-repairs:{' '}
                  {sim.metrics.ledgerAnomalyReport.autoRepairsAttempted})
                </div>
                {sim.metrics.ledgerAnomalyReport.preExistingUnbalanced.map((tx) => (
                  <div key={tx.transactionId} className="font-mono text-[11px] text-amber-300/90">
                    • {tx.transactionId} (net={tx.netMinorUnits} minor units, entries={tx.entryCount})
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Synthetic Roster Grid */}
          <Card>
            <CardTitle className="text-base mb-1">
              Synthetic User Roster ({sim.roster.length} users)
            </CardTitle>
            <CardDescription className="mb-4">
              Showing {Math.min(sim.roster.length, 60)} of {sim.roster.length} independent sessions, WebSocket states, and workflow counts.
            </CardDescription>
            {sim.roster.length === 0 ? (
              <div className="py-8 text-center text-sm text-[#8FA3B7]">
                No simulation roster active yet. Click Start Simulation to spawn {userCount} synthetic users.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                {sim.roster.slice(0, 60).map((u) => (
                  <div
                    key={u.index}
                    className="p-3 rounded-lg bg-[#08121E] border border-[#274056] space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#F5F7FA]">{u.label}</span>
                      <Badge variant={u.online ? 'success' : 'default'}>
                        {u.online ? 'Online' : 'Offline'}
                      </Badge>
                    </div>
                    <div className="text-[11px] font-mono text-[#8FA3B7] truncate">{u.email}</div>
                    <div className="flex items-center justify-between text-xs text-[#8FA3B7]">
                      <span>{u.currentActivity}</span>
                      <span>{u.lastLatencyMs !== null ? `${u.lastLatencyMs}ms` : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#8FA3B7]">
                      <span>Done: {u.completedWorkflows}</span>
                      <span>Errors: {u.failedWorkflows}</span>
                    </div>
                    {u.lastError && (
                      <div className="text-[11px] text-rose-400 truncate" title={u.lastError}>
                        {u.lastError}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Activity Feed & Reported Backend Gaps */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardTitle className="text-base mb-3">Live Event Timeline</CardTitle>
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {sim.activityFeed.length === 0 ? (
                  <p className="text-sm text-[#8FA3B7]">No events logged yet.</p>
                ) : (
                  sim.activityFeed.map((ev) => (
                    <div
                      key={ev.id}
                      className="text-xs p-2.5 rounded-lg bg-[#08121E] border border-[#1A2F42] flex items-start justify-between gap-3"
                    >
                      <span className="text-[#F5F7FA]">{ev.message}</span>
                      <span className="text-[#8FA3B7] shrink-0">{formatDate(ev.timestamp)}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <Card>
              <CardTitle className="text-base mb-3">Documented Architectural Gaps</CardTitle>
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {Object.keys(sim.gaps).length === 0 ? (
                  <p className="text-sm text-[#8FA3B7]">
                    No missing player-route gaps recorded in this run yet.
                  </p>
                ) : (
                  Object.entries(sim.gaps).map(([key, val]) => (
                    <div
                      key={key}
                      className="text-xs p-2.5 rounded-lg bg-[#08121E] border border-[#1A2F42] space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-amber-300">{key}</span>
                        <Badge variant="warning">{val.count}x</Badge>
                      </div>
                      {val.detail && <p className="text-[#8FA3B7]">{val.detail}</p>}
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}


export default function SimulationLabPage() {
  return (
    <RouteGuard permission={PERMISSIONS.ROLES_ADMIN} section="Simulation Lab">
      <SimulationLabPageContent />
    </RouteGuard>
  );
}
