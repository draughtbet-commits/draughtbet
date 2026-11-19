'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { MatchListItem, MatchDetailResponse } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatDate, formatNaira } from '@/lib/utils';
import {
  Swords,
  RefreshCw,
  Search,
  Eye,
  Clock,
  Wifi,
  Receipt,
  Layers,
  ChevronLeft,
  ChevronRight,
  X,
  History,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

export default function MatchesPage() {
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Match Detail Modal
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [matchDetail, setMatchDetail] = useState<MatchDetailResponse['match'] | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMatches = useCallback((targetPage = page, status = statusFilter, tier = tierFilter) => {
    setIsLoading(true);
    setError(null);
    adminApi.getMatches({
      page: targetPage,
      limit: 10,
      status: status === 'ALL' ? undefined : status,
      tier: tier === 'ALL' ? undefined : tier
    })
      .then((data) => {
        setMatches(data.matches || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to fetch matches');
      })
      .finally(() => setIsLoading(false));
  }, [page, statusFilter, tierFilter]);

  useEffect(() => {
    let active = true;
    const poll = () => {
      adminApi.getMatches({
        page,
        limit: 10,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        tier: tierFilter === 'ALL' ? undefined : tierFilter
      })
        .then((data) => {
          if (!active) return;
          setMatches(data.matches || []);
          setTotalPages(data.totalPages || 1);
          setTotal(data.total || 0);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : 'Failed to fetch matches');
        })
        .finally(() => {
          if (active) setIsLoading(false);
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
  }, [page, statusFilter, tierFilter]);

  const openMatchDetail = async (id: string) => {
    setSelectedMatchId(id);
    setIsDetailLoading(true);
    try {
      const res = await adminApi.getMatchDetail(id);
      setMatchDetail(res.match);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load match detail');
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeMatchDetail = () => {
    setSelectedMatchId(null);
    setMatchDetail(null);
  };

  const getMatchStatusBadge = (status: string) => {
    switch (status) {
      case 'IN_PROGRESS':
      case 'IN_PLAY':
      case 'ACTIVE':
      case 'READY':
      case 'FUNDED':
        return <Badge variant="warning">{status.replace(/_/g, ' ')}</Badge>;
      case 'COMPLETED':
      case 'SETTLED':
        return <Badge variant="success">{status === 'SETTLED' ? 'Settled' : 'Completed'}</Badge>;
      case 'CANCELLED':
        return <Badge variant="default">Cancelled</Badge>;
      case 'ABANDONED':
      case 'FORFEITED':
      case 'EXPIRED':
        return <Badge variant="danger">{status === 'FORFEITED' ? 'Forfeited' : 'Abandoned'}</Badge>;
      case 'DISPUTED':
        return <Badge variant="gold">Disputed</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            Match Operations & Lifecycle Directory
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Active games, move history, turn clocks, connection telemetry, and ledger reconciliation references.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchMatches()}
          isLoading={isLoading}
          className="gap-1.5 h-8 text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Directory</span>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 text-xs">
        {['ALL', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED', 'CANCELLED', 'ABANDONED'].map((st) => (
          <button
            key={st}
            onClick={() => {
              setStatusFilter(st);
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
              statusFilter === st
                ? 'bg-[#18C986] text-[#000000] font-bold'
                : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
            }`}
          >
            {st === 'ALL' ? 'All Statuses' : st.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Matches Table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Match ID</th>
                <th className="py-3 px-4">Light Player (White)</th>
                <th className="py-3 px-4">Dark Player (Black)</th>
                <th className="py-3 px-4">Stake (NGN)</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Inspection</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#274056]">
              {matches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#53677A]">
                    {isLoading ? 'Loading matches...' : 'No matches found.'}
                  </td>
                </tr>
              ) : (
                matches.map((m) => (
                  <tr key={m.id} className="hover:bg-[#132638]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                      {formatDate(m.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#18C986]">
                      {m.id.slice(0, 8)}...
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-[#F5F7FA]">
                        {m.playerLight?.username || m.playerLight?.fullName || m.playerLight?.id.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-[#8FA3B7] font-mono">
                        {m.playerLight?.email}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-[#F5F7FA]">
                        {m.playerDark?.username || m.playerDark?.fullName || m.playerDark?.id.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-[#8FA3B7] font-mono">
                        {m.playerDark?.email}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-sm font-semibold text-[#F5F7FA]">
                      {formatNaira(m.stakeMinorUnits)}
                    </td>
                    <td className="py-3 px-4">
                      {getMatchStatusBadge(m.status)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openMatchDetail(m.id)}
                        className="gap-1.5 h-8 text-xs"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Inspect Match</span>
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="p-3 bg-[#0C1B2A] border-t border-[#274056] flex items-center justify-between text-xs text-[#8FA3B7]">
          <span>
            Total Matches: <strong className="text-[#F5F7FA] font-mono">{total}</strong>
          </span>
          <div className="flex items-center gap-2">
            <span>Page {page} of {totalPages}</span>
            <div className="flex gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* ===================== MATCH DETAIL MODAL ===================== */}
      {selectedMatchId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Swords className="w-5 h-5 text-[#18C986]" />
                <div>
                  <h2 className="text-sm font-bold text-[#F5F7FA]">
                    10x10 International Draughts Match Inspector
                  </h2>
                  <p className="text-[11px] font-mono text-[#8FA3B7]">
                    Match ID: {selectedMatchId}
                  </p>
                </div>
              </div>
              <button
                onClick={closeMatchDetail}
                className="text-[#8FA3B7] hover:text-[#F5F7FA] p-1 rounded-md transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs text-[#F5F7FA]">
              {isDetailLoading || !matchDetail ? (
                <div className="py-16 text-center text-[#8FA3B7]">Loading full match details...</div>
              ) : (
                <>
                  {/* Match Overview Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Light Player (White)</span>
                      <p className="font-semibold text-sm">{matchDetail.playerLight?.username || matchDetail.playerLight?.id.slice(0, 8)}</p>
                      <p className="text-[11px] text-[#8FA3B7] font-mono">{matchDetail.playerLight?.email}</p>
                      <p className="text-[10px] text-[#18C986]">Tier: {matchDetail.playerLight?.tier || 'TIER_1'}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Dark Player (Black)</span>
                      <p className="font-semibold text-sm">{matchDetail.playerDark?.username || matchDetail.playerDark?.id.slice(0, 8)}</p>
                      <p className="text-[11px] text-[#8FA3B7] font-mono">{matchDetail.playerDark?.email}</p>
                      <p className="text-[10px] text-[#18C986]">Tier: {matchDetail.playerDark?.tier || 'TIER_1'}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Financial & Stake</span>
                      <p className="font-mono text-base font-bold text-[#18C986]">{formatNaira(matchDetail.stakeMinorUnits)}</p>
                      <p className="text-[11px] text-[#8FA3B7]">
                        Commission: <strong className="text-[#F5F7FA]">{matchDetail.settlementCommissionPercent || 5}%</strong>
                      </p>
                      <p className="text-[11px] text-[#8FA3B7]">
                        Status: <strong className="text-[#F5F7FA]">{matchDetail.status}</strong>
                      </p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Ruleset & Configuration</span>
                      <p className="text-[11px] text-[#F5F7FA]">Ruleset: <strong className="text-[#18C986]">v{matchDetail.rulesetVersion || 1}</strong></p>
                      <p className="text-[11px] text-[#F5F7FA]">Config: <strong className="text-[#18C986]">v{matchDetail.configurationVersion || 1}</strong></p>
                      <p className="text-[11px] text-[#8FA3B7]">Clock: {matchDetail.timeControlSeconds || 300}s</p>
                    </div>
                  </div>

                  {/* Move History Log */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7] flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5 text-[#18C986]" />
                      <span>Authoritative Move History ({matchDetail.moves?.length || 0} moves)</span>
                    </h3>
                    <div className="border border-[#274056] rounded-lg max-h-48 overflow-y-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#132638] text-[#8FA3B7] uppercase text-[10px] sticky top-0">
                          <tr>
                            <th className="py-2 px-3">#</th>
                            <th className="py-2 px-3">Player</th>
                            <th className="py-2 px-3">From Sq</th>
                            <th className="py-2 px-3">To Sq</th>
                            <th className="py-2 px-3">King Move</th>
                            <th className="py-2 px-3">Captures</th>
                            <th className="py-2 px-3">Timestamp</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#274056]">
                          {!matchDetail.moves || matchDetail.moves.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="py-4 text-center text-[#53677A]">
                                No moves made in this match yet.
                              </td>
                            </tr>
                          ) : (
                            matchDetail.moves.map((mv) => (
                              <tr key={mv.id} className="hover:bg-[#132638]/20">
                                <td className="py-1.5 px-3 font-mono font-bold text-[#18C986]">{mv.moveNumber}</td>
                                <td className="py-1.5 px-3 font-mono text-[11px] text-[#8FA3B7]">{mv.playerId.slice(0, 8)}...</td>
                                <td className="py-1.5 px-3 font-mono">{mv.fromSquare}</td>
                                <td className="py-1.5 px-3 font-mono">{mv.toSquare}</td>
                                <td className="py-1.5 px-3">{mv.isKingMove ? <span className="text-amber-400 font-bold">KING</span> : '—'}</td>
                                <td className="py-1.5 px-3 font-mono text-[11px]">
                                  {mv.capturedSquares && mv.capturedSquares.length > 0 ? mv.capturedSquares.join(', ') : '—'}
                                </td>
                                <td className="py-1.5 px-3 font-mono text-[10px] text-[#53677A]">{formatDate(mv.createdAt)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Connection Telemetry */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7] flex items-center gap-1.5">
                      <Wifi className="w-3.5 h-3.5 text-sky-400" />
                      <span>Connection & Socket Events ({matchDetail.connectionEvents?.length || 0})</span>
                    </h3>
                    <div className="border border-[#274056] rounded-lg max-h-36 overflow-y-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#132638] text-[#8FA3B7] uppercase text-[10px] sticky top-0">
                          <tr>
                            <th className="py-1.5 px-3">Timestamp</th>
                            <th className="py-1.5 px-3">User</th>
                            <th className="py-1.5 px-3">State</th>
                            <th className="py-1.5 px-3">IP Address</th>
                            <th className="py-1.5 px-3">User Agent</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#274056]">
                          {!matchDetail.connectionEvents || matchDetail.connectionEvents.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-3 text-center text-[#53677A]">No connection events recorded.</td>
                            </tr>
                          ) : (
                            matchDetail.connectionEvents.map((ce) => (
                              <tr key={ce.id} className="hover:bg-[#132638]/20">
                                <td className="py-1.5 px-3 font-mono text-[10px] text-[#8FA3B7]">{formatDate(ce.createdAt)}</td>
                                <td className="py-1.5 px-3 font-mono text-[11px] text-[#F5F7FA]">{ce.userId.slice(0, 8)}...</td>
                                <td className="py-1.5 px-3">
                                  <Badge variant={ce.state === 'CONNECTED' ? 'success' : 'danger'}>
                                    {ce.state}
                                  </Badge>
                                </td>
                                <td className="py-1.5 px-3 font-mono text-[10px] text-[#8FA3B7]">{ce.ipAddress || '—'}</td>
                                <td className="py-1.5 px-3 text-[10px] text-[#53677A] truncate max-w-xs">{ce.userAgent || '—'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Ledger Reconciliation References */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7] flex items-center gap-1.5">
                      <Receipt className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Ledger Settlements & Financial References</span>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1.5">
                        <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Stake Reservations</span>
                        {matchDetail.stakeReservations && matchDetail.stakeReservations.length > 0 ? (
                          matchDetail.stakeReservations.map((sr) => (
                            <div key={sr.id} className="flex justify-between items-center text-[11px] border-b border-[#274056] pb-1">
                              <span className="font-mono text-[#8FA3B7]">{sr.userId.slice(0, 8)}...</span>
                              <span className="font-mono text-[#18C986]">{formatNaira(sr.amountMinorUnits)}</span>
                              <Badge variant="info">{sr.status}</Badge>
                            </div>
                          ))
                        ) : (
                          <p className="text-[11px] text-[#53677A]">No reservations found.</p>
                        )}
                      </div>

                      <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1.5">
                        <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Settlement Receipts</span>
                        {matchDetail.receipts && matchDetail.receipts.length > 0 ? (
                          matchDetail.receipts.map((rc) => (
                            <div key={rc.id} className="flex justify-between items-center text-[11px] border-b border-[#274056] pb-1">
                              <span className="font-mono text-[#8FA3B7]">{rc.userId.slice(0, 8)}...</span>
                              <span className="font-mono text-emerald-400">Payout: {formatNaira(rc.payoutMinorUnits)}</span>
                              <span className="font-mono text-[10px] text-[#53677A]">Fee: {formatNaira(rc.feeMinorUnits)}</span>
                            </div>
                          ))
                        ) : (
                          <p className="text-[11px] text-[#53677A]">No settlement receipts recorded.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
