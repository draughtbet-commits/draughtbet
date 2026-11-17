'use client';

import React, { useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import { WithdrawalItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatNaira, formatDate } from '@/lib/utils';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { WithdrawalDetailModal } from '@/components/withdrawals/WithdrawalDetailModal';
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  Play,
  ChevronLeft,
  ChevronRight,
  Eye,
  Search,
  Wallet
} from 'lucide-react';

export default function WithdrawalsPage() {
  const { user } = useAuth();
  const [withdrawals, setWithdrawals] = useState<WithdrawalItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('PENDING_REVIEW');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);

  // Selected withdrawal for detail view
  const [selectedWithdrawalId, setSelectedWithdrawalId] = useState<string | null>(null);

  // Reject modal state
  const [rejectingItem, setRejectingItem] = useState<WithdrawalItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const canProcess = canAccessPermission(user, PERMISSIONS.WITHDRAWALS_PROCESS);

  const fetchWithdrawals = (targetPage = page, status = statusFilter) => {
    setIsLoading(true);
    setActionError(null);
    adminApi.getWithdrawals({
      page: targetPage,
      limit: 15,
      status: status || undefined
    })
      .then((data) => {
        setWithdrawals(data.withdrawals || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        if (err instanceof Error) setActionError(err.message);
        else setActionError('Failed to load withdrawal queue.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  useEffect(() => {
    let active = true;
    adminApi.getWithdrawals({
      page,
      limit: 15,
      status: statusFilter || undefined
    })
      .then((data) => {
        if (!active) return;
        setWithdrawals(data.withdrawals || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof Error) setActionError(err.message);
        else setActionError('Failed to load withdrawal queue.');
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [page, statusFilter]);

  const handleApprove = async (id: string) => {
    setActionError(null);
    setActionSuccess(null);
    setActiveActionId(id);
    try {
      await adminApi.approveWithdrawal(id);
      setActionSuccess('Withdrawal approved successfully.');
      fetchWithdrawals();
    } catch (err: unknown) {
      if (err instanceof Error) setActionError(err.message);
      else setActionError('Failed to approve withdrawal.');
    } finally {
      setActiveActionId(null);
    }
  };

  const handleBeginPayout = async (id: string) => {
    setActionError(null);
    setActionSuccess(null);
    setActiveActionId(id);
    try {
      await adminApi.beginWithdrawalPayout(id);
      setActionSuccess('Payout transfer initiated with payment gateway.');
      fetchWithdrawals();
    } catch (err: unknown) {
      if (err instanceof Error) setActionError(err.message);
      else setActionError('Failed to begin payout.');
    } finally {
      setActiveActionId(null);
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingItem) return;
    setActionError(null);
    setActionSuccess(null);
    setActiveActionId(rejectingItem.id);
    try {
      await adminApi.rejectWithdrawal(
        rejectingItem.id,
        rejectReason.trim() || 'Rejected by finance operator'
      );
      setActionSuccess(
        'Withdrawal rejected. Reserved funds automatically released back to player wallet.'
      );
      setRejectingItem(null);
      setRejectReason('');
      fetchWithdrawals();
    } catch (err: unknown) {
      if (err instanceof Error) setActionError(err.message);
      else setActionError('Failed to reject withdrawal.');
    } finally {
      setActiveActionId(null);
    }
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return 'success';
      case 'PENDING_REVIEW':
        return 'warning';
      case 'APPROVED':
      case 'PROCESSING':
        return 'info';
      case 'FAILED':
      case 'RELEASED':
        return 'danger';
      default:
        return 'default';
    }
  };

  // Filter client-side if search string is entered
  const filteredWithdrawals = withdrawals.filter((w) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase().trim();
    return (
      w.reference.toLowerCase().includes(term) ||
      w.userId.toLowerCase().includes(term) ||
      (w.user?.email && w.user.email.toLowerCase().includes(term)) ||
      (w.user?.username && w.user.username.toLowerCase().includes(term)) ||
      (w.bankAccount?.bankName && w.bankAccount.bankName.toLowerCase().includes(term)) ||
      (w.bankAccount?.accountNumber && w.bankAccount.accountNumber.includes(term))
    );
  });

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#2E333B]">
        <div>
          <h1 className="text-2xl font-bold font-serif tracking-tight text-[#F4F2ED]">
            Withdrawals Operations & Queue
          </h1>
          <p className="text-xs text-[#9CA3AF] mt-0.5">
            Finance operational queue. Authoritative review, payout dispatching, provider result reporting, and ledger releases.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchWithdrawals()}
          isLoading={isLoading}
          className="gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Queue</span>
        </Button>
      </div>

      {actionSuccess && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2.5 text-xs text-emerald-400">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {actionError && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-2.5 text-xs text-rose-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Filter Tabs and Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#2E333B] pb-3">
        <div className="flex gap-2 overflow-x-auto text-xs">
          {[
            { label: 'Pending Review', value: 'PENDING_REVIEW' },
            { label: 'Approved', value: 'APPROVED' },
            { label: 'Processing', value: 'PROCESSING' },
            { label: 'Completed', value: 'COMPLETED' },
            { label: 'Failed / Released', value: 'FAILED' },
            { label: 'All Requests', value: '' }
          ].map((tab) => (
            <button
              key={tab.label}
              onClick={() => {
                setStatusFilter(tab.value);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors whitespace-nowrap ${
                statusFilter === tab.value
                  ? 'bg-[#E7B24A] text-[#0B0D10] font-bold'
                  : 'bg-[#15181D] text-[#9CA3AF] hover:text-[#F4F2ED] border border-[#2E333B]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
          <input
            type="text"
            placeholder="Filter queue by reference or user..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-[#E7B24A]"
          />
        </div>
      </div>

      {/* Withdrawal Queue Table */}
      <Card className="overflow-hidden p-0 border-[#2E333B]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#1E2229] text-[#9CA3AF] border-b border-[#2E333B] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Player Details</th>
                <th className="py-3 px-4">Destination Bank</th>
                <th className="py-3 px-4">Reference</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2E333B]">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#9CA3AF]">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#E7B24A]" />
                    Loading withdrawal queue...
                  </td>
                </tr>
              ) : filteredWithdrawals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#6B7280]">
                    <Wallet className="w-8 h-8 mx-auto mb-2 opacity-40 text-[#E7B24A]" />
                    No withdrawal records matching criteria.
                  </td>
                </tr>
              ) : (
                filteredWithdrawals.map((w) => (
                  <tr key={w.id} className="hover:bg-[#1E2229]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#9CA3AF] whitespace-nowrap">
                      {formatDate(w.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-bold font-mono text-sm text-[#F4F2ED]">
                      {formatNaira(w.amountMinorUnits)}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={getStatusBadgeVariant(w.status)}>{w.status}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      <span className="block font-semibold text-[#F4F2ED]">
                        {w.user?.username || w.user?.email || w.userId.slice(0, 8)}
                      </span>
                      {w.user?.email && (
                        <span className="text-[10px] text-[#9CA3AF] font-mono block">
                          {w.user.email}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {w.bankAccount ? (
                        <div>
                          <span className="block font-semibold text-[#F4F2ED]">
                            {w.bankAccount.bankName}
                          </span>
                          <span className="text-[11px] font-mono text-[#9CA3AF]">
                            {w.bankAccount.accountNumber} ({w.bankAccount.accountName || '—'})
                          </span>
                        </div>
                      ) : (
                        <span className="text-[#6B7280] italic">No bank attached</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#9CA3AF] select-all">
                      {w.reference}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelectedWithdrawalId(w.id)}
                          className="gap-1 text-xs"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Review</span>
                        </Button>

                        {canProcess && w.status === 'PENDING_REVIEW' && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              isLoading={activeActionId === w.id}
                              onClick={() => handleApprove(w.id)}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={activeActionId === w.id}
                              onClick={() => setRejectingItem(w)}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {canProcess && w.status === 'APPROVED' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            isLoading={activeActionId === w.id}
                            onClick={() => handleBeginPayout(w.id)}
                            className="text-emerald-400 gap-1 border-emerald-500/30"
                          >
                            <Play className="w-3 h-3" />
                            <span>Payout</span>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="p-3 bg-[#111317] border-t border-[#2E333B] flex items-center justify-between text-xs text-[#9CA3AF]">
          <span>
            Total: <strong className="text-[#F4F2ED] font-mono">{total}</strong> | Page{' '}
            <strong className="text-[#F4F2ED] font-mono">{page}</strong> of{' '}
            <strong className="text-[#F4F2ED] font-mono">{totalPages}</strong>
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Quick Reject Modal */}
      {rejectingItem && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <Card className="max-w-md w-full bg-[#15181D] border-[#2E333B] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-rose-400">
              <XCircle className="w-5 h-5" />
              <h3 className="font-bold text-base text-[#F4F2ED]">Reject & Release Funds</h3>
            </div>
            <p className="text-xs text-[#9CA3AF]">
              Rejecting withdrawal <b className="text-emerald-400 font-mono">{formatNaira(rejectingItem.amountMinorUnits)}</b> for{' '}
              <b className="text-[#F4F2ED]">{rejectingItem.user?.email || rejectingItem.userId}</b> will return the locked balance to their available wallet.
            </p>
            <form onSubmit={handleConfirmReject} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#9CA3AF] mb-1">
                  Reason for rejection (audited & notified to player)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Bank name mismatch, Fraud check failure"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="w-full px-3 py-2 bg-[#1E2229] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-rose-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRejectingItem(null)}
                  disabled={activeActionId === rejectingItem.id}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  size="sm"
                  isLoading={activeActionId === rejectingItem.id}
                >
                  Confirm Rejection & Release
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Withdrawal Detail Modal */}
      {selectedWithdrawalId && (
        <WithdrawalDetailModal
          withdrawalId={selectedWithdrawalId}
          onClose={() => setSelectedWithdrawalId(null)}
          onUpdated={() => fetchWithdrawals()}
        />
      )}
    </div>
  );
}
