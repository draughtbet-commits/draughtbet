'use client';

import React, { useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import { SystemHealthResponse } from '@/lib/api/types';
import { Card, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/lib/utils';
import {
  Activity,
  RefreshCw,
  Database,
  Server,
  Layers,
  Radio,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ShieldCheck,
  X
} from 'lucide-react';

export default function HealthPage() {
  const [healthData, setHealthData] = useState<SystemHealthResponse['health'] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchHealth = () => {
    setIsLoading(true);
    setError(null);
    adminApi.getSystemHealth()
      .then((res) => {
        setHealthData(res.health);
        setLastRefreshed(new Date());
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to probe system health');
      })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000); // Probe every 30s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            System Health & Service Probes
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Real-time readiness probes, latency benchmarks, Redis worker queues, outbox drainer, and payment provider routes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#8FA3B7] font-mono">
            Last check: {formatDate(lastRefreshed.toISOString())}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchHealth}
            isLoading={isLoading}
            className="gap-1.5 h-8 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Probe Now</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-between text-xs text-rose-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Global Status Banner */}
      <div className="p-4 bg-[#0C1B2A] border border-[#274056] rounded-xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              healthData?.status === 'HEALTHY' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
            }`}
          />
          <div>
            <div className="text-sm font-bold text-[#F5F7FA]">
              Cluster Operational Status:{' '}
              <span className={healthData?.status === 'HEALTHY' ? 'text-emerald-400' : 'text-amber-400'}>
                {healthData?.status || 'PROBING...'}
              </span>
            </div>
            <div className="text-xs text-[#8FA3B7]">
              All core services reporting live telemetry to the admin supervision cluster.
            </div>
          </div>
        </div>
        {healthData && (
          <div className="flex items-center gap-4 text-xs font-mono">
            <div>
              <span className="text-[#8FA3B7]">Active Matches: </span>
              <strong className="text-[#18C986]">{healthData.metrics.activeMatches}</strong>
            </div>
            <div>
              <span className="text-[#8FA3B7]">Audit Events (1h): </span>
              <strong className="text-[#F5F7FA]">{healthData.metrics.auditActionsLastHour}</strong>
            </div>
          </div>
        )}
      </div>

      {/* Service Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* PostgreSQL */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-[#18C986]" />
              <CardTitle className="text-sm">PostgreSQL (Neon)</CardTitle>
            </div>
            <Badge variant={healthData?.services.database.status === 'HEALTHY' ? 'success' : 'warning'}>
              {healthData?.services.database.status || 'CHECKING'}
            </Badge>
          </div>
          <CardDescription>
            Authoritative transactional schema storage for players, wallets, ledger, and match records.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Latency</span>
            <strong className="text-emerald-400">
              {healthData ? `${healthData.services.database.latencyMs}ms` : '—'}
            </strong>
          </div>
        </Card>

        {/* Redis */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-[#18C986]" />
              <CardTitle className="text-sm">Redis 7 Cluster</CardTitle>
            </div>
            <Badge variant={healthData?.services.cacheAndQueues.status === 'HEALTHY' ? 'success' : 'warning'}>
              {healthData?.services.cacheAndQueues.status || 'CHECKING'}
            </Badge>
          </div>
          <CardDescription>
            In-memory turn clocks, CAS move arbitration, session token revocation sets, and rate limiters.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Latency</span>
            <strong className="text-emerald-400">
              {healthData ? `${healthData.services.cacheAndQueues.latencyMs}ms` : '—'}
            </strong>
          </div>
        </Card>

        {/* Outbox Drainer */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#18C986]" />
              <CardTitle className="text-sm">Outbox Event Drainer</CardTitle>
            </div>
            <Badge variant={healthData?.services.outboxDrainer.status === 'DRAINING' ? 'success' : 'warning'}>
              {healthData?.services.outboxDrainer.status || 'ACTIVE'}
            </Badge>
          </div>
          <CardDescription>
            Transactional outbox pattern worker delivering asynchronous domain events with restart-safe leases.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Pending Events</span>
            <strong className="text-[#F5F7FA]">
              {healthData ? healthData.services.outboxDrainer.pendingCount : 0}
            </strong>
          </div>
        </Card>

        {/* Socket.IO */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-sky-400" />
              <CardTitle className="text-sm">Socket.IO Game Mesh</CardTitle>
            </div>
            <Badge variant={healthData?.services.gameSocketLayer.status === 'OPERATIONAL' ? 'success' : 'warning'}>
              {healthData?.services.gameSocketLayer.status || 'OPERATIONAL'}
            </Badge>
          </div>
          <CardDescription>
            Full-duplex WebSocket gateway handling live match turns, clock pulses, and connection telemetry.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Active Game Sockets</span>
            <strong className="text-sky-400">
              {healthData ? healthData.services.gameSocketLayer.activeMatchesCount : 0}
            </strong>
          </div>
        </Card>

        {/* Paystack Gateway */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-emerald-400" />
              <CardTitle className="text-sm">Paystack Payments</CardTitle>
            </div>
            <Badge variant="info">
              {healthData?.services.paymentGateways.paystack.status || 'CONFIGURED'}
            </Badge>
          </div>
          <CardDescription>
            Card / bank transfer payment collection, webhook signature verification (HMAC-SHA512), and payout execution.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Operating Mode</span>
            <strong className="text-[#18C986] uppercase">
              {healthData?.services.paymentGateways.paystack.mode || 'LIVE'}
            </strong>
          </div>
        </Card>

        {/* Flutterwave Gateway */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-amber-400" />
              <CardTitle className="text-sm">Flutterwave Payments</CardTitle>
            </div>
            <Badge variant="info">
              {healthData?.services.paymentGateways.flutterwave.status || 'CONFIGURED'}
            </Badge>
          </div>
          <CardDescription>
            Secondary payout route and multi-channel funding gateway with verif-hash payload validation.
          </CardDescription>
          <div className="pt-2 border-t border-[#274056] flex items-center justify-between text-[11px] font-mono text-[#8FA3B7]">
            <span>Operating Mode</span>
            <strong className="text-[#18C986] uppercase">
              {healthData?.services.paymentGateways.flutterwave.mode || 'LIVE'}
            </strong>
          </div>
        </Card>
      </div>
    </div>
  );
}
