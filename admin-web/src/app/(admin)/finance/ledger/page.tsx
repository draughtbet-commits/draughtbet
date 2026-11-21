'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import type {
  AdminDepositItem,
  AdminDepositsResponse,
  AdminLedgerTransactionItem
} from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate, formatNaira } from '@/lib/utils';
import {
  ArrowDownToLine,
  Receipt,
  RefreshCw,
  Search,
  Eye,
  ChevronLeft,
  ChevronRight,
  X,
  Scale,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';

type ActiveTab = 'deposits' | 'ledger';

const NON_WITHDRAWAL_TYPES = [
  'ALL',
  'DEPOSIT_CREDIT',
  'STAKE_LOCK',
  'STAKE_RELEASE',
  'SETTLEMENT_PAYOUT',
  'ADJUSTMENT'
] as const;

function TopUpsAndLedgerPageContent() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('deposits');

  // Deposits / Balance Top-Ups state
  const [deposits, setDeposits] = useState<AdminDepositItem[]>([]);
  const [depositSummary, setDepositSummary] = useState<AdminDepositsResponse['summary'] | null>(null);
  const [depositPage, setDepositPage] = useState(1);
  const [depositTotalPages, setDepositTotalPages] = useState(1);
  const [depositTotal, setDepositTotal] = useState(0);
  const [depositStatusFilter, setDepositStatusFilter] = useState('ALL');
  const [depositGatewayFilter, setDepositGatewayFilter] = useState('ALL');
  const [depositSearch, setDepositSearch] = useState('');
  const [isDepositsLoading, setIsDepositsLoading] = useState(true);

  // Non-Withdrawal Money Ledger state
  const [transactions, setTransactions] = useState<AdminLedgerTransactionItem[]>([]);
  const [txPage, setTxPage] = useState(1);
  const [txTotalPages, setTxTotalPages] = useState(1);
  const [txTotal, setTxTotal] = useState(0);
  const [txTypeFilter, setTxTypeFilter] = useState('ALL');
  const [txSearch, setTxSearch] = useState('');
  const [isTxLoading, setIsTxLoading] = useState(true);
  const [selectedTx, setSelectedTx] = useState<AdminLedgerTransactionItem | null>(null);

  const [error, setError] = useState<string | null>(null);

  const loadDeposits = useCallback(async (targetPage = depositPage) => {
    try {
      const res = await adminApi.getDeposits({
        page: targetPage,
        limit: 20,
        status: depositStatusFilter === 'ALL' ? undefined : depositStatusFilter,
        gateway: depositGatewayFilter === 'ALL' ? undefined : depositGatewayFilter,
        search: depositSearch.trim() || undefined
      });
      setDeposits(res.deposits);
      setDepositSummary(res.summary);
      setDepositTotal(res.total);
      setDepositTotalPages(res.totalPages);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load user top-ups');
    } finally {
      setIsDepositsLoading(false);
    }
  }, [depositPage, depositStatusFilter, depositGatewayFilter, depositSearch]);

  const loadTransactions = useCallback(async (targetPage = txPage) => {
    try {
      const res = await adminApi.getLedgerTransactions({
        page: targetPage,
        limit: 20,
        type: txTypeFilter === 'ALL' ? undefined : txTypeFilter,
        excludeWithdrawals: true,
        search: txSearch.trim() || undefined
      });
      setTransactions(res.transactions);
      setTxTotal(res.total);
      setTxTotalPages(res.totalPages);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load money transactions');
    } finally {
      setIsTxLoading(false);
    }
  }, [txPage, txTypeFilter, txSearch]);

  useEffect(() => {
    let active = true;
    const poll = () => {
      adminApi
        .getDeposits({
          page: depositPage,
          limit: 20,
          status: depositStatusFilter === 'ALL' ? undefined : depositStatusFilter,
          gateway: depositGatewayFilter === 'ALL' ? undefined : depositGatewayFilter,
          search: depositSearch.trim() || undefined
        })
        .then((res) => {
          if (!active) return;
          setDeposits(res.deposits);
          setDepositSummary(res.summary);
          setDepositTotal(res.total);
          setDepositTotalPages(res.totalPages);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : 'Failed to load user top-ups');
        })
        .finally(() => {
          if (active) setIsDepositsLoading(false);
        });
    };

    poll();
    const timer = setInterval(() => {
      if (activeTab === 'deposits' && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        poll();
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeTab, depositPage, depositStatusFilter, depositGatewayFilter, depositSearch]);

  useEffect(() => {
    let active = true;
    const poll = () => {
      adminApi
        .getLedgerTransactions({
          page: txPage,
          limit: 20,
          type: txTypeFilter === 'ALL' ? undefined : txTypeFilter,
          excludeWithdrawals: true,
          search: txSearch.trim() || undefined
        })
        .then((res) => {
          if (!active) return;
          setTransactions(res.transactions);
          setTxTotal(res.total);
          setTxTotalPages(res.totalPages);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : 'Failed to load money transactions');
        })
        .finally(() => {
          if (active) setIsTxLoading(false);
        });
    };

    poll();
    const timer = setInterval(() => {
      if (activeTab === 'ledger' && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        poll();
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeTab, txPage, txTypeFilter, txSearch]);

  const getDepositStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <Badge variant="success">Completed</Badge>;
      case 'PENDING':
        return <Badge variant="warning">Pending</Badge>;
      case 'FAILED':
        return <Badge variant="danger">Failed</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  const getLedgerTypeBadge = (type: string) => {
    switch (type) {
      case 'DEPOSIT_CREDIT':
        return <Badge variant="success">Top-Up Credit</Badge>;
      case 'SETTLEMENT_PAYOUT':
        return <Badge variant="gold">Match Payout</Badge>;
      case 'STAKE_LOCK':
        return <Badge variant="info">Stake Lock</Badge>;
      case 'STAKE_RELEASE':
        return <Badge variant="default">Stake Release</Badge>;
      case 'ADJUSTMENT':
        return <Badge variant="warning">Admin Adjustment</Badge>;
      default:
        return <Badge variant="default">{type}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA] flex items-center gap-2.5">
            <Receipt className="w-6 h-6 text-[#18C986]" />
            Balance Top-Ups &amp; Money Transactions
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Trace every player deposit top-up, match escrow lock, stake release, settlement payout, and sanctioned adjustment (excluding withdrawals).
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (activeTab === 'deposits') {
              setIsDepositsLoading(true);
              void loadDeposits(depositPage);
            } else {
              setIsTxLoading(true);
              void loadTransactions(txPage);
            }
          }}
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${(activeTab === 'deposits' ? isDepositsLoading : isTxLoading) ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Top-Up Summary KPIs */}
      {depositSummary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <div className="text-xs text-[#8FA3B7] uppercase">Completed Top-Up Volume</div>
            <div className="text-xl font-bold text-[#18C986] mt-1 font-mono">
              {formatNaira(depositSummary.completedVolumeMinorUnits)}
            </div>
            <div className="text-[11px] text-[#8FA3B7] mt-1">
              {depositSummary.completedCount} settled deposits
            </div>
          </Card>
          <Card>
            <div className="text-xs text-[#8FA3B7] uppercase">Matching Top-Up Intents</div>
            <div className="text-xl font-bold text-[#F5F7FA] mt-1 font-mono">
              {depositSummary.totalCount}
            </div>
            <div className="text-[11px] text-[#8FA3B7] mt-1">
              {depositSummary.pendingCount} pending · {depositSummary.failedCount} failed
            </div>
          </Card>
          <Card>
            <div className="text-xs text-[#8FA3B7] uppercase">Non-Withdrawal Ledger Rows</div>
            <div className="text-xl font-bold text-[#F5F7FA] mt-1 font-mono">{txTotal}</div>
            <div className="text-[11px] text-[#8FA3B7] mt-1">
              Deposits, stakes, payouts &amp; adjustments
            </div>
          </Card>
          <Card>
            <div className="text-xs text-[#8FA3B7] uppercase">Scope Filter</div>
            <div className="text-sm font-semibold text-[#F5F7FA] mt-1 flex items-center gap-1.5">
              <Scale className="w-4 h-4 text-[#18C986]" />
              Withdrawals Excluded
            </div>
            <div className="text-[11px] text-[#8FA3B7] mt-1">
              Managed separately in Withdrawal Queue
            </div>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setActiveTab('deposits')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors ${
            activeTab === 'deposits'
              ? 'bg-[#18C986] text-[#000000]'
              : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
          }`}
        >
          <ArrowDownToLine className="w-3.5 h-3.5" />
          User Balance Top-Ups ({depositTotal})
        </button>
        <button
          onClick={() => setActiveTab('ledger')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors ${
            activeTab === 'ledger'
              ? 'bg-[#18C986] text-[#000000]'
              : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          All Non-Withdrawal Money Ledger ({txTotal})
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB 1: BALANCE TOP-UPS TRACE */}
      {activeTab === 'deposits' && (
        <Card>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div className="md:col-span-2 relative">
              <Search className="w-4 h-4 text-[#8FA3B7] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={depositSearch}
                onChange={(e) => {
                  setDepositPage(1);
                  setDepositSearch(e.target.value);
                }}
                placeholder="Trace by user email, username, userId, or payment reference..."
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] placeholder-[#52657A] focus:outline-none focus:border-[#18C986]"
              />
            </div>
            <select
              value={depositStatusFilter}
              onChange={(e) => {
                setDepositPage(1);
                setDepositStatusFilter(e.target.value);
              }}
              className="px-3 py-2 text-xs rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="ALL">All Top-Up Statuses</option>
              <option value="COMPLETED">Completed Only</option>
              <option value="PENDING">Pending Only</option>
              <option value="FAILED">Failed Only</option>
            </select>
            <select
              value={depositGatewayFilter}
              onChange={(e) => {
                setDepositPage(1);
                setDepositGatewayFilter(e.target.value);
              }}
              className="px-3 py-2 text-xs rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="ALL">All Gateways</option>
              <option value="PAYSTACK">Paystack</option>
              <option value="FLUTTERWAVE">Flutterwave</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] uppercase tracking-wider text-[#8FA3B7] bg-[#132638]">
                  <th className="py-2.5 px-3">Initiated</th>
                  <th className="py-2.5 px-3">Credited (Applied)</th>
                  <th className="py-2.5 px-3">Player</th>
                  <th className="py-2.5 px-3">Gateway</th>
                  <th className="py-2.5 px-3">Reference</th>
                  <th className="py-2.5 px-3">Amount</th>
                  <th className="py-2.5 px-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A2F42]">
                {isDepositsLoading && deposits.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-[#8FA3B7]">
                      Loading balance top-ups...
                    </td>
                  </tr>
                ) : deposits.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-[#8FA3B7]">
                      No balance top-ups found matching filters.
                    </td>
                  </tr>
                ) : (
                  deposits.map((dep) => (
                    <tr key={dep.id} className="hover:bg-[#0D1E2E]/60">
                      <td className="py-2.5 px-3 whitespace-nowrap font-mono text-[11px] text-[#8FA3B7]">
                        {formatDate(dep.createdAt)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap font-mono text-[11px] text-[#F5F7FA]">
                        {dep.appliedAt ? formatDate(dep.appliedAt) : '—'}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-[#F5F7FA]">
                          {dep.user?.email ?? dep.userId}
                        </div>
                        <div className="text-[11px] text-[#8FA3B7]">
                          {dep.user?.username ? `@${dep.user.username}` : dep.userId.slice(0, 8)} ·{' '}
                          {dep.user?.tier ?? 'AMATEUR'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <Badge variant="info">{dep.gateway}</Badge>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#8FA3B7]">
                        {dep.reference}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap font-mono font-semibold text-[#18C986]">
                        {formatNaira(dep.amountMinorUnits)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {getDepositStatusBadge(dep.status)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-4 mt-4 border-t border-[#1A2F42] text-xs text-[#8FA3B7]">
            <span>
              Page {depositPage} of {depositTotalPages} ({depositTotal} top-ups)
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={depositPage <= 1}
                onClick={() => setDepositPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={depositPage >= depositTotalPages}
                onClick={() => setDepositPage((p) => Math.min(depositTotalPages, p + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* TAB 2: ALL NON-WITHDRAWAL MONEY TRANSACTIONS */}
      {activeTab === 'ledger' && (
        <Card>
          <div className="flex flex-col md:flex-row gap-3 mb-4">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 text-[#8FA3B7] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={txSearch}
                onChange={(e) => {
                  setTxPage(1);
                  setTxSearch(e.target.value);
                }}
                placeholder="Search by user email, username, transaction ID, match ID, or idempotency key..."
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg bg-[#08121E] border border-[#274056] text-[#F5F7FA] placeholder-[#52657A] focus:outline-none focus:border-[#18C986]"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {NON_WITHDRAWAL_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setTxPage(1);
                    setTxTypeFilter(t);
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${
                    txTypeFilter === t
                      ? 'bg-[#18C986] text-[#000000] font-bold'
                      : 'bg-[#08121E] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
                  }`}
                >
                  {t === 'ALL' ? 'All Non-Withdrawal' : t.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] uppercase tracking-wider text-[#8FA3B7] bg-[#132638]">
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Players Involved</th>
                  <th className="py-2.5 px-3">Description &amp; Match</th>
                  <th className="py-2.5 px-3">Gross Volume</th>
                  <th className="py-2.5 px-3">Double-Entry</th>
                  <th className="py-2.5 px-3 text-right">Legs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A2F42]">
                {isTxLoading && transactions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-[#8FA3B7]">
                      Loading non-withdrawal money transactions...
                    </td>
                  </tr>
                ) : transactions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-[#8FA3B7]">
                      No money transactions found matching filters.
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-[#0D1E2E]/60">
                      <td className="py-2.5 px-3 whitespace-nowrap font-mono text-[11px] text-[#8FA3B7]">
                        {formatDate(tx.createdAt)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {getLedgerTypeBadge(tx.type)}
                      </td>
                      <td className="py-2.5 px-3">
                        {tx.users.length === 0 ? (
                          <span className="text-[#8FA3B7]">System Accounts Only</span>
                        ) : (
                          tx.users.map((u) => (
                            <div key={u.id} className="text-[11px] text-[#F5F7FA] font-mono">
                              {u.email}
                            </div>
                          ))
                        )}
                      </td>
                      <td className="py-2.5 px-3 max-w-xs">
                        <div className="text-[#F5F7FA] truncate" title={tx.description || ''}>
                          {tx.description || tx.idempotencyKey || tx.id}
                        </div>
                        {tx.relatedMatchId && (
                          <div className="text-[10px] font-mono text-[#8FA3B7]">
                            Match: {tx.relatedMatchId.slice(0, 8)}...
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap font-mono font-semibold text-[#18C986]">
                        {formatNaira(tx.totalVolumeMinorUnits)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {tx.balanced ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px]">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Balanced ({tx.entries.length} legs)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-400 text-[11px] font-mono">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Net {tx.netMinorUnits}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelectedTx(tx)}
                        >
                          <Eye className="w-3.5 h-3.5 mr-1" />
                          Inspect
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-4 mt-4 border-t border-[#1A2F42] text-xs text-[#8FA3B7]">
            <span>
              Page {txPage} of {txTotalPages} ({txTotal} non-withdrawal transactions)
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={txPage <= 1}
                onClick={() => setTxPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={txPage >= txTotalPages}
                onClick={() => setTxPage((p) => Math.min(txTotalPages, p + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Double-Entry Legs Inspector Modal */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-[#F5F7FA]">
                  Double-Entry Transaction Legs
                </h2>
                <p className="text-[11px] font-mono text-[#8FA3B7]">
                  {selectedTx.id} · {selectedTx.type}
                </p>
              </div>
              <button
                onClick={() => setSelectedTx(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA] p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-[#08121E] border border-[#274056]">
                <div>
                  <span className="text-[#8FA3B7]">Created:</span>{' '}
                  <span className="font-mono text-[#F5F7FA]">{formatDate(selectedTx.createdAt)}</span>
                </div>
                <div>
                  <span className="text-[#8FA3B7]">Net Sum:</span>{' '}
                  <span className="font-mono text-[#F5F7FA]">{selectedTx.netMinorUnits} minor units</span>
                </div>
                <div className="col-span-2">
                  <span className="text-[#8FA3B7]">Idempotency Key:</span>{' '}
                  <span className="font-mono text-[#F5F7FA]">{selectedTx.idempotencyKey || '—'}</span>
                </div>
              </div>

              <div className="border border-[#274056] rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#132638] text-[#8FA3B7] text-[10px] uppercase">
                    <tr>
                      <th className="py-2 px-3">Account Type</th>
                      <th className="py-2 px-3">Owner</th>
                      <th className="py-2 px-3 text-right">Signed Amount (Minor Units)</th>
                      <th className="py-2 px-3 text-right">Major Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A2F42]">
                    {selectedTx.entries.map((entry) => {
                      const val = BigInt(entry.amountMinorUnits);
                      const isCredit = val > 0n;
                      return (
                        <tr key={entry.id}>
                          <td className="py-2 px-3 font-mono text-[#F5F7FA]">{entry.accountType}</td>
                          <td className="py-2 px-3 text-[#8FA3B7] font-mono">
                            {entry.user?.email ?? 'SYSTEM'}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono font-semibold ${
                              isCredit ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isCredit ? `+${entry.amountMinorUnits}` : entry.amountMinorUnits}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[#F5F7FA]">
                            {formatNaira(val < 0n ? (-val).toString() : val.toString())}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default function TopUpsAndLedgerPage() {
  return (
    <RouteGuard permission={PERMISSIONS.WITHDRAWALS_READ} section="Top-Ups & Ledger">
      <TopUpsAndLedgerPageContent />
    </RouteGuard>
  );
}
