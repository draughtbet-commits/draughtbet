'use client';

import React, { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api/admin';
import { WithdrawalItem, AuditLogItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatNaira, formatDate } from '@/lib/utils';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import {
  X,
  Wallet,
  CheckCircle,
  XCircle,
  Play,
  AlertTriangle,
  FileText,
  RefreshCw,
  Send
} from 'lucide-react';

interface WithdrawalDetailModalProps {
  withdrawalId: string;
  onClose: () => void;
  onUpdated?: () => void;
}

export function WithdrawalDetailModal({
  withdrawalId,
  onClose,
  onUpdated
}: WithdrawalDetailModalProps) {
  const { user: currentAdmin } = useAuth();
  const [data, setData] = useState<(WithdrawalItem & { auditHistory?: AuditLogItem[] }) | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal sub-actions
  const [actionModal, setActionModal] = useState<
    'approve' | 'beginPayout' | 'reject' | 'reportResult' | null
  >(null);
  const [rejectReason, setRejectReason] = useState('');
  const [reportResultSuccess, setReportResultSuccess] = useState(true);
  const [reportFailureReason, setReportFailureReason] = useState('');

  const canProcess = canAccessPermission(currentAdmin, PERMISSIONS.WITHDRAWALS_PROCESS);

  const fetchDetail = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await adminApi.getWithdrawal(withdrawalId);
      setData(res.withdrawal);
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to load withdrawal details.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    adminApi.getWithdrawal(withdrawalId)
      .then((res) => {
        if (!active) return;
        setData(res.withdrawal);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof Error) setError(err.message);
        else setError('Failed to load withdrawal details.');
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [withdrawalId]);

  const handleApprove = async () => {
    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await adminApi.approveWithdrawal(withdrawalId);
      setSuccessMessage('Withdrawal approved successfully.');
      setActionModal(null);
      await fetchDetail();
      onUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to approve withdrawal.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleBeginPayout = async () => {
    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await adminApi.beginWithdrawalPayout(withdrawalId);
      setSuccessMessage('Payout transfer dispatched to gateway.');
      setActionModal(null);
      await fetchDetail();
      onUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to initiate payout.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await adminApi.rejectWithdrawal(
        withdrawalId,
        rejectReason.trim() || 'Rejected by finance operator'
      );
      setSuccessMessage('Withdrawal rejected. Reserved funds released back to player wallet.');
      setActionModal(null);
      await fetchDetail();
      onUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to reject withdrawal.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReportResult = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await adminApi.reportWithdrawalResult(withdrawalId, {
        success: reportResultSuccess,
        failureReason: !reportResultSuccess ? reportFailureReason.trim() || 'Payout transfer failed' : undefined
      });
      setSuccessMessage(
        reportResultSuccess
          ? 'Payout marked COMPLETED. Ledger finalized.'
          : 'Payout failure recorded. May be retried or released.'
      );
      setActionModal(null);
      await fetchDetail();
      onUpdated?.();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to report payout result.');
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <Badge variant="success">COMPLETED</Badge>;
      case 'PENDING_REVIEW':
        return <Badge variant="warning">PENDING REVIEW</Badge>;
      case 'APPROVED':
        return <Badge variant="info">APPROVED</Badge>;
      case 'PROCESSING':
        return <Badge variant="info">PROCESSING PAYOUT</Badge>;
      case 'FAILED':
        return <Badge variant="danger">PAYOUT FAILED</Badge>;
      case 'RELEASED':
        return <Badge variant="danger">RELEASED / RETURNED</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl bg-[#15181D] border border-[#2E333B] shadow-2xl overflow-hidden text-[#F4F2ED]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2E333B] bg-[#111317]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold font-serif text-[#F4F2ED]">
                  Withdrawal Review & Audit
                </h2>
                {data && getStatusBadge(data.status)}
              </div>
              <span className="text-xs text-[#9CA3AF] font-mono">
                Ref: {data?.reference || withdrawalId}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchDetail}
              isLoading={isLoading}
              className="text-[#9CA3AF] hover:text-[#F4F2ED]"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-[#F4F2ED] hover:bg-[#1E2229] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Notifications */}
        {successMessage && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="py-20 text-center text-[#9CA3AF] text-sm">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-[#E7B24A]" />
              Loading withdrawal dossier...
            </div>
          ) : !data ? (
            <div className="py-20 text-center text-rose-400 text-sm">
              Withdrawal record not found.
            </div>
          ) : (
            <>
              {/* Financial & Destination Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Financial Summary */}
                <Card className="bg-[#1A1D24] border-[#2E333B]">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                    Settlement Details
                  </h3>
                  <div className="p-4 rounded-xl bg-[#111317] border border-[#2E333B] mb-4">
                    <span className="text-[10px] uppercase text-[#9CA3AF] block">Disbursement Amount</span>
                    <span className="text-2xl font-bold font-mono text-emerald-400">
                      {formatNaira(data.amountMinorUnits)}
                    </span>
                    <span className="text-[11px] font-mono text-[#9CA3AF] block mt-0.5">
                      Minor units: {data.amountMinorUnits} {data.currency}
                    </span>
                  </div>

                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Status</dt>
                      <dd>{getStatusBadge(data.status)}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Gateway Provider</dt>
                      <dd className="font-mono text-[#F4F2ED]">{data.gateway}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Server Reference</dt>
                      <dd className="font-mono text-[#F4F2ED]">{data.reference}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Provider Transfer Ref</dt>
                      <dd className="font-mono text-[#F4F2ED]">{data.providerRef || 'Not assigned yet'}</dd>
                    </div>
                    <div className="flex justify-between py-1">
                      <dt className="text-[#9CA3AF]">Requested At</dt>
                      <dd className="font-mono text-[#F4F2ED]">{formatDate(data.createdAt)}</dd>
                    </div>
                  </dl>
                </Card>

                {/* Player & Bank Account */}
                <Card className="bg-[#1A1D24] border-[#2E333B]">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                    Destination & Player Account
                  </h3>
                  {data.bankAccount ? (
                    <div className="p-4 rounded-xl bg-[#111317] border border-[#2E333B] mb-4">
                      <span className="text-[10px] uppercase text-[#9CA3AF] block">Bank Account Destination</span>
                      <span className="text-base font-bold text-[#F4F2ED] block">
                        {data.bankAccount.bankName}
                      </span>
                      <span className="text-xs font-mono text-[#E7B24A] block">
                        {data.bankAccount.accountNumber}
                      </span>
                      <span className="text-[11px] text-[#9CA3AF] block mt-0.5">
                        Account Name: {data.bankAccount.accountName || '—'}
                      </span>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-4">
                      No linked bank account found on this request.
                    </div>
                  )}

                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Player User ID</dt>
                      <dd className="font-mono text-[#F4F2ED]">{data.userId}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Email</dt>
                      <dd className="font-mono text-[#F4F2ED]">{data.user?.email || '—'}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">Username</dt>
                      <dd className="text-[#F4F2ED]">{data.user?.username || '—'}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#2E333B]/40">
                      <dt className="text-[#9CA3AF]">KYC Status</dt>
                      <dd>
                        <Badge variant={data.user?.kycStatus === 'VERIFIED' ? 'success' : 'default'}>
                          {data.user?.kycStatus || 'UNKNOWN'}
                        </Badge>
                      </dd>
                    </div>
                    <div className="flex justify-between py-1">
                      <dt className="text-[#9CA3AF]">Account Status</dt>
                      <dd>
                        <Badge variant={data.user?.isBanned ? 'danger' : 'success'}>
                          {data.user?.isBanned ? 'Suspended' : 'Active'}
                        </Badge>
                      </dd>
                    </div>
                  </dl>
                </Card>
              </div>

              {/* Reviewer / Failure Metadata */}
              {(data.reviewedBy || data.failureReason) && (
                <Card className="bg-[#1A1D24] border-[#2E333B]">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3">
                    Review Metadata
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    {data.reviewedBy && (
                      <div>
                        <span className="text-[#9CA3AF] block">Reviewed By Admin:</span>
                        <span className="font-mono text-[#F4F2ED]">{data.reviewedBy}</span>
                        {data.reviewedAt && (
                          <span className="text-[11px] font-mono text-[#9CA3AF] block">
                            At: {formatDate(data.reviewedAt)}
                          </span>
                        )}
                      </div>
                    )}
                    {data.failureReason && (
                      <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20">
                        <span className="text-rose-400 font-bold block">Failure / Rejection Reason:</span>
                        <span className="text-rose-300">{data.failureReason}</span>
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {/* Consequential Action Bar */}
              {canProcess && (
                <div className="p-4 rounded-xl bg-[#1E2229] border border-[#2E333B] flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="text-xs font-bold text-[#F4F2ED]">
                      Finance Operational Actions
                    </h4>
                    <p className="text-[11px] text-[#9CA3AF]">
                      State-machine gated mutations. Every action requires authorization and is recorded in the double-entry audit trail.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {data.status === 'PENDING_REVIEW' && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setActionModal('approve')}
                          className="gap-1.5"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          <span>Approve Withdrawal</span>
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setActionModal('reject')}
                          className="gap-1.5"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Reject & Release</span>
                        </Button>
                      </>
                    )}

                    {(data.status === 'APPROVED' || data.status === 'FAILED') && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setActionModal('beginPayout')}
                          className="gap-1.5 text-emerald-400 border-emerald-500/30"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>Begin Payout Transfer</span>
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setActionModal('reject')}
                          className="gap-1.5"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Reject & Release</span>
                        </Button>
                      </>
                    )}

                    {data.status === 'PROCESSING' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setActionModal('reportResult')}
                        className="gap-1.5"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Report Provider Result</span>
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Immutable Audit Trail Specific to this Withdrawal */}
              <Card className="bg-[#1A1D24] border-[#2E333B]">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#9CA3AF] mb-3 flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-[#E7B24A]" />
                  Withdrawal Mutation Audit Trail
                </h3>
                {!data.auditHistory || data.auditHistory.length === 0 ? (
                  <p className="text-xs text-[#6B7280] py-4 text-center">
                    No administrative audit entries logged for this withdrawal yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#1E2229] text-[#9CA3AF] border-y border-[#2E333B] uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">Date</th>
                          <th className="py-2 px-3">Action</th>
                          <th className="py-2 px-3">Outcome</th>
                          <th className="py-2 px-3">Operator ID</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#2E333B]">
                        {data.auditHistory.map((item) => (
                          <tr key={item.id} className="hover:bg-[#1E2229]/50">
                            <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                              {formatDate(item.createdAt)}
                            </td>
                            <td className="py-2 px-3 font-bold text-[#F4F2ED]">
                              {item.action}
                            </td>
                            <td className="py-2 px-3">
                              <Badge variant={item.outcome === 'SUCCESS' ? 'success' : 'danger'}>
                                {item.outcome}
                              </Badge>
                            </td>
                            <td className="py-2 px-3 font-mono text-[11px] text-[#9CA3AF]">
                              {item.adminId.slice(0, 8)}...
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>

        {/* Action Confirmation Dialogs */}
        {actionModal === 'approve' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md p-6 rounded-xl bg-[#1E2229] border border-[#2E333B] shadow-2xl space-y-4">
              <h3 className="text-sm font-bold text-[#F4F2ED] flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                Confirm Withdrawal Approval
              </h3>
              <p className="text-xs text-[#9CA3AF]">
                Approve withdrawal of <b className="text-emerald-400 font-mono">{formatNaira(data?.amountMinorUnits || '0')}</b> for{' '}
                <b className="text-[#F4F2ED]">{data?.user?.email || data?.userId}</b>?
                This transitions the request to APPROVED state awaiting payout initiation.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setActionModal(null)} disabled={actionLoading}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={handleApprove} isLoading={actionLoading}>
                  Confirm Approval
                </Button>
              </div>
            </div>
          </div>
        )}

        {actionModal === 'beginPayout' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md p-6 rounded-xl bg-[#1E2229] border border-[#2E333B] shadow-2xl space-y-4">
              <h3 className="text-sm font-bold text-[#F4F2ED] flex items-center gap-2">
                <Play className="w-4 h-4 text-[#E7B24A]" />
                Initiate Gateway Payout Transfer
              </h3>
              <p className="text-xs text-[#9CA3AF]">
                Dispatch a real payout transfer of <b className="text-emerald-400 font-mono">{formatNaira(data?.amountMinorUnits || '0')}</b> to{' '}
                <b className="text-[#F4F2ED]">{data?.bankAccount?.bankName} ({data?.bankAccount?.accountNumber})</b> via {data?.gateway}?
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setActionModal(null)} disabled={actionLoading}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={handleBeginPayout} isLoading={actionLoading}>
                  Dispatch Payout
                </Button>
              </div>
            </div>
          </div>
        )}

        {actionModal === 'reject' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <form onSubmit={handleReject} className="w-full max-w-md p-6 rounded-xl bg-[#1E2229] border border-[#2E333B] shadow-2xl space-y-4">
              <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2">
                <XCircle className="w-4 h-4" />
                Confirm Withdrawal Rejection & Fund Release
              </h3>
              <p className="text-xs text-[#9CA3AF]">
                Rejecting this request will automatically release the reserved{' '}
                <b className="text-emerald-400 font-mono">{formatNaira(data?.amountMinorUnits || '0')}</b> back to the player&apos;s available ledger balance.
              </p>
              <div>
                <label className="block text-xs font-semibold text-[#9CA3AF] mb-1">
                  Rejection Reason (audited and notified to player)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Account name mismatch, Suspicious wagering pattern"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="w-full px-3 py-2 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-rose-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setActionModal(null)} disabled={actionLoading}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" size="sm" isLoading={actionLoading}>
                  Confirm Rejection & Release
                </Button>
              </div>
            </form>
          </div>
        )}

        {actionModal === 'reportResult' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <form onSubmit={handleReportResult} className="w-full max-w-md p-6 rounded-xl bg-[#1E2229] border border-[#2E333B] shadow-2xl space-y-4">
              <h3 className="text-sm font-bold text-[#F4F2ED] flex items-center gap-2">
                <Send className="w-4 h-4 text-sky-400" />
                Report Provider Transfer Result
              </h3>
              <p className="text-xs text-[#9CA3AF]">
                Record the outcome reported by Paystack/Flutterwave for transfer <b className="font-mono text-[#F4F2ED]">{data?.reference}</b>.
              </p>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[#9CA3AF]">
                  Gateway Outcome
                </label>
                <div className="flex gap-4 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="success"
                      checked={reportResultSuccess}
                      onChange={() => setReportResultSuccess(true)}
                    />
                    <span className="text-emerald-400 font-bold">SUCCESS (Settled)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="success"
                      checked={!reportResultSuccess}
                      onChange={() => setReportResultSuccess(false)}
                    />
                    <span className="text-rose-400 font-bold">FAILURE (Declined)</span>
                  </label>
                </div>
              </div>

              {!reportResultSuccess && (
                <div>
                  <label className="block text-xs font-semibold text-[#9CA3AF] mb-1">
                    Gateway Failure Reason
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Invalid destination bank account number"
                    value={reportFailureReason}
                    onChange={(e) => setReportFailureReason(e.target.value)}
                    className="w-full px-3 py-2 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-rose-500"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setActionModal(null)} disabled={actionLoading}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" isLoading={actionLoading}>
                  Submit Result
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
