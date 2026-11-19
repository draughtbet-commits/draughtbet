'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { VerificationCaseItem, VerificationDocumentAccessResponse } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Search,
  Eye,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Lock,
  FileText,
  Clock,
  Shield,
  X
} from 'lucide-react';

export default function KycPage() {
  const [cases, setCases] = useState<VerificationCaseItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail Modal / Drawer state
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<VerificationCaseItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  // Document Signed Access state
  const [docAccess, setDocAccess] = useState<VerificationDocumentAccessResponse | null>(null);
  const [isDocAccessLoading, setIsDocAccessLoading] = useState(false);
  const [docAccessError, setDocAccessError] = useState<string | null>(null);

  // Action dialog states
  const [actionType, setActionType] = useState<'APPROVE' | 'REJECT' | 'REQUEST_INFO' | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  const fetchCases = useCallback((targetPage = page, status = statusFilter, query = search) => {
    setIsLoading(true);
    setError(null);
    adminApi.getVerificationCases({
      page: targetPage,
      limit: 10,
      status: status === 'ALL' ? undefined : status,
      search: query.trim() || undefined
    })
      .then((data) => {
        setCases(data.cases || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        if (err instanceof Error) setError(err.message);
        else setError('Failed to load KYC verification cases.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [page, statusFilter, search]);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  const openDetail = async (caseId: string) => {
    setSelectedCaseId(caseId);
    setIsDetailLoading(true);
    setDocAccess(null);
    setDocAccessError(null);
    setActionType(null);
    setActionReason('');
    setActionSuccessMsg(null);

    try {
      const res = await adminApi.getVerificationCaseDetail(caseId);
      setActiveCase(res.verificationCase);
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to load verification case detail');
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedCaseId(null);
    setActiveCase(null);
    setDocAccess(null);
    setActionType(null);
  };

  const handleRequestDocumentAccess = async (checkId?: string) => {
    if (!selectedCaseId) return;
    setIsDocAccessLoading(true);
    setDocAccessError(null);
    try {
      const res = await adminApi.getVerificationDocumentAccess(selectedCaseId, checkId);
      setDocAccess(res.documentAccess);
    } catch (err: unknown) {
      if (err instanceof Error) setDocAccessError(err.message);
      else setDocAccessError('Could not generate secure signed document access token.');
    } finally {
      setIsDocAccessLoading(false);
    }
  };

  const handleExecuteAction = async () => {
    if (!selectedCaseId || !actionType) return;
    setIsSubmittingAction(true);
    try {
      if (actionType === 'APPROVE') {
        await adminApi.approveVerificationCase(selectedCaseId, actionReason || undefined);
        setActionSuccessMsg('Verification case approved successfully.');
      } else if (actionType === 'REJECT') {
        if (!actionReason.trim()) {
          setError('Rejection reason is required.');
          setIsSubmittingAction(false);
          return;
        }
        await adminApi.rejectVerificationCase(selectedCaseId, actionReason.trim());
        setActionSuccessMsg('Verification case rejected.');
      } else if (actionType === 'REQUEST_INFO') {
        if (!actionReason.trim()) {
          setError('Specification of required information is mandatory.');
          setIsSubmittingAction(false);
          return;
        }
        await adminApi.requestAdditionalKycInfo(selectedCaseId, actionReason.trim());
        setActionSuccessMsg('Additional information requested from player.');
      }

      // Reload detail and list
      const updated = await adminApi.getVerificationCaseDetail(selectedCaseId);
      setActiveCase(updated.verificationCase);
      setActionType(null);
      setActionReason('');
      fetchCases();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError('Failed to perform verification action.');
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'VERIFIED':
        return <Badge variant="success">Verified</Badge>;
      case 'PENDING':
        return <Badge variant="warning">Pending</Badge>;
      case 'UNDER_REVIEW':
        return <Badge variant="info">Under Review</Badge>;
      case 'ADDITIONAL_INFO_REQUIRED':
        return <Badge variant="gold">Info Required</Badge>;
      case 'REJECTED':
        return <Badge variant="danger">Rejected</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            KYC & Compliance Queue
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Identity documents, age-verification evidence, ephemeral signed access, and regulatory reviews.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchCases()}
          isLoading={isLoading}
          className="gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Queue</span>
        </Button>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="flex gap-1.5 overflow-x-auto pb-1 text-xs">
          {['ALL', 'PENDING', 'UNDER_REVIEW', 'ADDITIONAL_INFO_REQUIRED', 'VERIFIED', 'REJECTED'].map((st) => (
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
              {st === 'ALL' ? 'All Applications' : st.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            fetchCases(1, statusFilter, search);
          }}
          className="flex items-center gap-2 max-w-sm"
        >
          <Input
            placeholder="Search email, username, ref..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" className="shrink-0 h-9 px-3">
            <Search className="w-3.5 h-3.5" />
          </Button>
        </form>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Verification Queue Table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Applicant / Player</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Provider / Verification</th>
                <th className="py-3 px-4">Age (18+)</th>
                <th className="py-3 px-4">Tier</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#274056]">
              {cases.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#53677A]">
                    {isLoading ? 'Loading KYC applications...' : 'No verification applications found.'}
                  </td>
                </tr>
              ) : (
                cases.map((c) => (
                  <tr key={c.id} className="hover:bg-[#132638]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                      {formatDate(c.createdAt)}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-[#F5F7FA]">
                        {c.user?.fullName || c.user?.username || c.user?.email || c.userId}
                      </div>
                      <div className="text-[11px] text-[#8FA3B7] font-mono">
                        {c.user?.email || c.userId}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(c.status)}
                    </td>
                    <td className="py-3 px-4 text-[#8FA3B7]">
                      <span className="font-mono uppercase text-[11px] text-[#F5F7FA]">
                        {c.provider || 'Dojah / manual'}
                      </span>
                      {c.checks && c.checks.length > 0 && (
                        <span className="block text-[10px] text-[#53677A]">
                          {c.checks.length} check{c.checks.length > 1 ? 's' : ''} recorded
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {c.user?.ageVerified ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" /> 18+ Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-400 text-[11px]">
                          <HelpCircle className="w-3.5 h-3.5" /> Unconfirmed
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#18C986]">
                      {c.user?.tier || 'TIER_1'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openDetail(c.id)}
                        className="gap-1.5 h-8 text-xs"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Inspect</span>
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
            Total Applications: <strong className="text-[#F5F7FA] font-mono">{total}</strong>
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[11px]">
              Page {page} of {totalPages}
            </span>
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

      {/* KYC Detail Drawer / Modal */}
      {selectedCaseId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Shield className="w-5 h-5 text-[#18C986]" />
                <div>
                  <h2 className="text-sm font-bold text-[#F5F7FA]">
                    KYC Verification Case Review
                  </h2>
                  <p className="text-[11px] font-mono text-[#8FA3B7]">
                    Case ID: {selectedCaseId}
                  </p>
                </div>
              </div>
              <button
                onClick={closeDetail}
                className="text-[#8FA3B7] hover:text-[#F5F7FA] p-1 rounded-md transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6 text-xs text-[#F5F7FA]">
              {isDetailLoading || !activeCase ? (
                <div className="py-16 text-center text-[#8FA3B7]">Loading case details...</div>
              ) : (
                <>
                  {actionSuccessMsg && (
                    <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 font-medium">
                      {actionSuccessMsg}
                    </div>
                  )}

                  {/* Summary Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Applicant Profile</span>
                      <p className="font-semibold text-sm">{activeCase.user?.fullName || 'No legal name on file'}</p>
                      <p className="text-[#8FA3B7] font-mono">{activeCase.user?.email}</p>
                      <p className="text-[#8FA3B7] font-mono">{activeCase.user?.phone || 'No phone'}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Status & Regulatory Compliance</span>
                      <div className="flex items-center gap-2 pt-0.5">
                        {getStatusBadge(activeCase.status)}
                        <Badge variant="gold">{activeCase.user?.tier || 'TIER_1'}</Badge>
                      </div>
                      <p className="text-[11px] pt-1">
                        Age 18+:{' '}
                        {activeCase.user?.ageVerified ? (
                          <strong className="text-emerald-400">Verified</strong>
                        ) : (
                          <strong className="text-amber-400">Unverified</strong>
                        )}
                      </p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Submission Metadata</span>
                      <p className="font-mono text-[11px] text-[#8FA3B7]">
                        Submitted: {formatDate(activeCase.createdAt)}
                      </p>
                      <p className="font-mono text-[11px] text-[#8FA3B7]">
                        Updated: {formatDate(activeCase.updatedAt)}
                      </p>
                      <p className="text-[11px] text-[#8FA3B7]">
                        Provider: <strong className="text-[#F5F7FA] uppercase">{activeCase.provider || 'Dojah'}</strong>
                      </p>
                    </div>
                  </div>

                  {/* Verification Checks Table */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Verification Checks & Evidence
                    </h3>
                    <div className="border border-[#274056] rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#132638] text-[#8FA3B7] uppercase text-[10px]">
                          <tr>
                            <th className="py-2.5 px-3">Check Type</th>
                            <th className="py-2.5 px-3">Status</th>
                            <th className="py-2.5 px-3">Provider Check ID</th>
                            <th className="py-2.5 px-3">Created</th>
                            <th className="py-2.5 px-3 text-right">Access</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#274056]">
                          {!activeCase.checks || activeCase.checks.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-4 text-center text-[#53677A]">
                                No discrete verification checks registered.
                              </td>
                            </tr>
                          ) : (
                            activeCase.checks.map((chk) => (
                              <tr key={chk.id} className="hover:bg-[#132638]/20">
                                <td className="py-2.5 px-3 font-semibold text-[#F5F7FA]">
                                  {chk.type}
                                </td>
                                <td className="py-2.5 px-3">
                                  <Badge variant={chk.status === 'VERIFIED' ? 'success' : 'warning'}>
                                    {chk.status}
                                  </Badge>
                                </td>
                                <td className="py-2.5 px-3 font-mono text-[11px] text-[#8FA3B7]">
                                  {chk.providerCheckId || '—'}
                                </td>
                                <td className="py-2.5 px-3 font-mono text-[11px] text-[#8FA3B7]">
                                  {formatDate(chk.createdAt)}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleRequestDocumentAccess(chk.id)}
                                    className="h-7 text-[11px] gap-1"
                                  >
                                    <Lock className="w-3 h-3 text-[#18C986]" />
                                    <span>Signed Access</span>
                                  </Button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Ephemeral Signed Access Box */}
                  <div className="p-4 bg-[#000000] border border-[#274056] rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-[#18C986]" />
                        <span className="font-bold text-xs uppercase tracking-wider text-[#F5F7FA]">
                          Secure Ephemeral Document Access (HMAC Watermarked)
                        </span>
                      </div>
                      {!docAccess && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleRequestDocumentAccess()}
                          isLoading={isDocAccessLoading}
                          className="h-7 text-xs"
                        >
                          Generate Ephemeral Access Token
                        </Button>
                      )}
                    </div>

                    {docAccessError && (
                      <div className="text-rose-400 text-xs">{docAccessError}</div>
                    )}

                    {docAccess && (
                      <div className="p-3 bg-[#0C1B2A] border border-[#18C986]/30 rounded space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-emerald-400 font-semibold flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Ephemeral Token Active
                          </span>
                          <span className="font-mono text-[#8FA3B7]">
                            Expires: {formatDate(docAccess.expiresAt || docAccess.access?.expiresAt)} (120s TTL)
                          </span>
                        </div>
                        <div className="font-mono text-[11px] bg-[#000000] p-2 rounded border border-[#274056] break-all text-[#8FA3B7]">
                          <span className="text-[#18C986]">Token:</span> {docAccess.signedToken || docAccess.access?.signedToken}
                        </div>
                        <div className="text-[11px] text-[#8FA3B7] flex items-center gap-3">
                          <span>Check Type: <strong className="text-[#F5F7FA]">{docAccess.checkType || docAccess.access?.checkType}</strong></span>
                          <span>Watermark: <strong className="text-[#18C986]">{docAccess.watermark || docAccess.access?.watermark}</strong></span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Audit History Timeline */}
                  {activeCase.auditHistory && activeCase.auditHistory.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7] flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        <span>Compliance Decision History</span>
                      </h3>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto">
                        {activeCase.auditHistory.map((item) => (
                          <div
                            key={item.id}
                            className="p-2 bg-[#000000] border border-[#274056] rounded flex items-center justify-between text-[11px]"
                          >
                            <div>
                              <span className="font-bold text-[#F5F7FA]">{item.action}</span>
                              <span className="text-[#8FA3B7] ml-2">by {item.admin?.email || item.adminId}</span>
                            </div>
                            <span className="font-mono text-[#53677A]">{formatDate(item.createdAt)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Action Section */}
                  {activeCase.status !== 'VERIFIED' && (
                    <div className="border-t border-[#274056] pt-4 space-y-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                        Regulatory Adjudication
                      </span>

                      {!actionType ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setActionType('APPROVE')}
                            className="gap-1.5"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Approve Verification</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setActionType('REJECT')}
                            className="gap-1.5"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Reject Application</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setActionType('REQUEST_INFO')}
                            className="gap-1.5"
                          >
                            <HelpCircle className="w-3.5 h-3.5 text-[#18C986]" />
                            <span>Request Additional Information</span>
                          </Button>
                        </div>
                      ) : (
                        <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[#F5F7FA]">
                              {actionType === 'APPROVE' && 'Confirm Approval'}
                              {actionType === 'REJECT' && 'Specify Rejection Reason (Mandatory)'}
                              {actionType === 'REQUEST_INFO' && 'Specify Required Additional Documents / Information'}
                            </span>
                            <button
                              onClick={() => setActionType(null)}
                              className="text-xs text-[#8FA3B7] hover:text-[#F5F7FA]"
                            >
                              Cancel
                            </button>
                          </div>
                          <Input
                            placeholder={
                              actionType === 'APPROVE'
                                ? 'Optional review note...'
                                : 'Enter detailed regulatory reason...'
                            }
                            value={actionReason}
                            onChange={(e) => setActionReason(e.target.value)}
                            className="h-9 text-xs"
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setActionType(null)}
                            >
                              Dismiss
                            </Button>
                            <Button
                              size="sm"
                              variant={actionType === 'REJECT' ? 'danger' : 'primary'}
                              onClick={handleExecuteAction}
                              isLoading={isSubmittingAction}
                            >
                              Confirm Action
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
