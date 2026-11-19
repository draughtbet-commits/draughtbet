'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminApi } from '@/lib/api/admin';
import { DashboardSummaryResponse } from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatNaira, formatDate } from '@/lib/utils';
import {
  Users,
  Swords,
  Wallet,
  ShieldCheck,
  Scale,
  ArrowRight,
  RefreshCw,
  Activity,
  FileText,
  AlertCircle
} from 'lucide-react';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await adminApi.getDashboardSummary();
      setData(res.summary);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to load operational dashboard summary.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const poll = () => {
      adminApi.getDashboardSummary()
        .then((res) => {
          if (active) {
            setData(res.summary);
            setError(null);
            setIsLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setError(err instanceof Error ? err.message : 'Failed to load operational dashboard summary.');
            setIsLoading(false);
          }
        });
    };

    poll();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        poll();
      }
    }, 5000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold font-serif tracking-tight text-[#F5F7FA]">
            Operations Dashboard
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Authoritative operational statistics aggregated from Backend V2 across players, matches, queues, and ledger state.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.generatedAt && (
            <span className="text-[11px] font-mono text-[#53677A]">
              Updated: {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={loadDashboard}
            isLoading={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Data</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={loadDashboard}>
            Retry
          </Button>
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Players Card */}
        <Card className="hover:border-[#18C986]/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#8FA3B7]">
                Registered Players
              </span>
              <div className="text-2xl font-bold font-mono text-[#F5F7FA] mt-2">
                {isLoading ? '...' : (data?.players.total ?? 0)}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs">
                <span className="text-emerald-400 font-mono">
                  {data?.players.active ?? 0} active
                </span>
                {(data?.players.banned ?? 0) > 0 && (
                  <span className="text-rose-400 font-mono">
                    · {data?.players.banned} suspended
                  </span>
                )}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#274056] flex justify-between items-center">
            <Link
              href="/players"
              className="text-xs font-semibold text-[#18C986] hover:underline inline-flex items-center gap-1"
            >
              <span>Player directory</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </Card>

        {/* Matches Card */}
        <Card className="hover:border-[#18C986]/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#8FA3B7]">
                Matches Activity
              </span>
              <div className="text-2xl font-bold font-mono text-[#F5F7FA] mt-2">
                {isLoading ? '...' : (data?.matches.total ?? 0)}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs">
                <span className="text-amber-400 font-mono">
                  {data?.matches.active ?? 0} active
                </span>
                <span className="text-[#8FA3B7] font-mono">
                  · {data?.matches.completed ?? 0} settled
                </span>
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Swords className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#274056] flex justify-between items-center">
            <Link
              href="/game-operations/matches"
              className="text-xs font-semibold text-[#18C986] hover:underline inline-flex items-center gap-1"
            >
              <span>Match monitor</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </Card>

        {/* Compliance / KYC Queue */}
        <Card className="hover:border-[#18C986]/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#8FA3B7]">
                Compliance Queues
              </span>
              <div className="text-2xl font-bold font-mono text-[#F5F7FA] mt-2">
                {isLoading ? '...' : (data?.compliance.pendingKyc ?? 0)}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs">
                <span className="text-purple-400 font-mono">KYC pending</span>
                {(data?.compliance.openRiskCases ?? 0) > 0 && (
                  <span className="text-rose-400 font-mono">
                    · {data?.compliance.openRiskCases} risk cases
                  </span>
                )}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#274056] flex justify-between items-center">
            <Link
              href="/compliance/kyc"
              className="text-xs font-semibold text-[#18C986] hover:underline inline-flex items-center gap-1"
            >
              <span>Review KYC</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </Card>

        {/* Financials / Withdrawals Queue */}
        {data?.financials ? (
          <Card className="hover:border-[#18C986]/40 transition-colors">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#8FA3B7]">
                  Pending Withdrawals
                </span>
                <div className="text-2xl font-bold font-mono text-[#F5F7FA] mt-2">
                  {isLoading ? '...' : data.financials.pendingWithdrawalsCount}
                </div>
                <div className="mt-1 text-xs font-mono text-emerald-400">
                  {formatNaira(data.financials.pendingWithdrawalsAmountMinorUnits)} total
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Wallet className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-[#274056] flex justify-between items-center">
              <Link
                href="/finance/withdrawals"
                className="text-xs font-semibold text-[#18C986] hover:underline inline-flex items-center gap-1"
              >
                <span>Process queue</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </Card>
        ) : (
          <Card className="hover:border-[#18C986]/40 transition-colors">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#8FA3B7]">
                  Disputes Queue
                </span>
                <div className="text-2xl font-bold font-mono text-[#F5F7FA] mt-2">
                  {isLoading ? '...' : (data?.matches.disputed ?? 0)}
                </div>
                <div className="mt-1 text-xs text-amber-400">
                  Awaiting review & evidence
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Scale className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-[#274056] flex justify-between items-center">
              <Link
                href="/game-operations/disputes"
                className="text-xs font-semibold text-[#18C986] hover:underline inline-flex items-center gap-1"
              >
                <span>Inspect disputes</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </Card>
        )}
      </div>

      {/* Financial 24h Summary Bar (if operator has financial permission) */}
      {data?.financials && (
        <div className="p-4 rounded-xl bg-[#0C1B2A] border border-[#274056] flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#18C986]/10 text-[#18C986]">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <span className="text-xs font-semibold text-[#F5F7FA]">
                24-Hour Completed Settlements
              </span>
              <p className="text-[11px] text-[#8FA3B7]">
                Pushed through Paystack/Flutterwave gateway rails and finalized in the double-entry ledger.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-6 font-mono text-xs">
            <div>
              <span className="text-[#8FA3B7] block text-[10px] uppercase">Disbursed (24h)</span>
              <span className="text-[#F5F7FA] font-bold text-sm">
                {formatNaira(data.financials.completedWithdrawals24hAmountMinorUnits)}
              </span>
            </div>
            <div>
              <span className="text-[#8FA3B7] block text-[10px] uppercase">Transactions</span>
              <span className="text-emerald-400 font-bold text-sm">
                {data.financials.completedWithdrawals24hCount}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Two Column Layout: System Status & Recent Privileged Action Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* System Invariants Summary */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-[#F5F7FA]">
              <Activity className="w-4 h-4 text-[#18C986]" />
              Platform Guarantees
            </CardTitle>
            <CardDescription>Server-enforced invariants</CardDescription>
          </CardHeader>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 bg-[#132638] rounded-lg border border-[#274056]">
              <span className="text-[#8FA3B7]">Double-Entry Ledger:</span>
              <Badge variant="success">Balanced (Zero-Sum)</Badge>
            </div>
            <div className="flex items-center justify-between p-3 bg-[#132638] rounded-lg border border-[#274056]">
              <span className="text-[#8FA3B7]">Turn Clock Authority:</span>
              <Badge variant="info">Server-Enforced (60s)</Badge>
            </div>
            <div className="flex items-center justify-between p-3 bg-[#132638] rounded-lg border border-[#274056]">
              <span className="text-[#8FA3B7]">Move Protocol:</span>
              <Badge variant="info">CAS Lua + Idempotent</Badge>
            </div>
            <div className="flex items-center justify-between p-3 bg-[#132638] rounded-lg border border-[#274056]">
              <span className="text-[#8FA3B7]">Role Enforcement:</span>
              <Badge variant="success">Fresh DB Bindings</Badge>
            </div>
          </div>
        </Card>

        {/* Live Immutable Audit Feed */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between w-full">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-[#F5F7FA]">
                  <FileText className="w-4 h-4 text-[#18C986]" />
                  Recent Privileged Audit Trail
                </CardTitle>
                <CardDescription>Authoritative administrative mutations</CardDescription>
              </div>
              <Link href="/system/audit">
                <Button variant="ghost" size="sm" className="text-xs">
                  View Full Trail
                </Button>
              </Link>
            </div>
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#132638] text-[#8FA3B7] border-y border-[#274056] uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Action</th>
                  <th className="py-2.5 px-3">Outcome</th>
                  <th className="py-2.5 px-3">Target</th>
                  <th className="py-2.5 px-3">Admin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056]">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#8FA3B7]">
                      Loading audit records...
                    </td>
                  </tr>
                ) : !data?.recentActivity || data.recentActivity.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#53677A]">
                      No audit events recorded yet.
                    </td>
                  </tr>
                ) : (
                  data.recentActivity.map((item) => (
                    <tr key={item.id} className="hover:bg-[#132638]/50 transition-colors">
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#8FA3B7] whitespace-nowrap">
                        {formatDate(item.createdAt)}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-[#F5F7FA]">
                        {item.action}
                      </td>
                      <td className="py-2.5 px-3">
                        <Badge
                          variant={
                            item.outcome === 'SUCCESS'
                              ? 'success'
                              : item.outcome === 'DENIED'
                              ? 'warning'
                              : 'danger'
                          }
                        >
                          {item.outcome}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3 text-[#8FA3B7] font-mono text-[11px]">
                        {item.targetType ? `${item.targetType}:${item.targetId || ''}` : '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#8FA3B7]">
                        {item.adminId ? `${item.adminId.slice(0, 8)}...` : 'system'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
