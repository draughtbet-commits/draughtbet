'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { DisputeItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { formatDate, formatNaira } from '@/lib/utils';
import {
  Scale,
  RefreshCw,
  Eye,
  CheckCircle2,
  XCircle,
  FilePlus2,
  X,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

function DisputesPageContent() {
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Dispute Detail Modal
  const [selectedDisputeId, setSelectedDisputeId] = useState<string | null>(null);
  const [activeDispute, setActiveDispute] = useState<DisputeItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  // Adjudication Dialog
  const [decisionType, setDecisionType] = useState<'RESOLVED' | 'DISMISSED' | null>(null);
  const [resolutionText, setResolutionText] = useState('');
  const [isSubmittingDecision, setIsSubmittingDecision] = useState(false);

  // Add Evidence Dialog
  const [isAddingEvidence, setIsAddingEvidence] = useState(false);
  const [evidenceType] = useState('SCREENSHOT');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [evidenceDesc, setEvidenceDesc] = useState('');
  const [isSubmittingEvidence, setIsSubmittingEvidence] = useState(false);

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchDisputes = useCallback(async (targetPage = page, status = statusFilter) => {
    try {
      const data = await adminApi.getDisputes({
        page: targetPage,
        limit: 10,
        status: status === 'ALL' ? undefined : status
      });
      setDisputes(data.disputes || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to fetch disputes'
      });
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    void (async () => {
      await fetchDisputes();
    })();
  }, [fetchDisputes]);

  const openDisputeDetail = async (id: string) => {
    setSelectedDisputeId(id);
    setIsDetailLoading(true);
    setDecisionType(null);
    setResolutionText('');
    setIsAddingEvidence(false);
    try {
      const res = await adminApi.getDisputeDetail(id);
      setActiveDispute(res.disputeCase);
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load dispute details'
      });
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeDisputeDetail = () => {
    setSelectedDisputeId(null);
    setActiveDispute(null);
    setDecisionType(null);
  };

  const handleDecideDispute = async () => {
    if (!selectedDisputeId || !decisionType) return;
    if (!resolutionText.trim()) {
      setNotification({ type: 'error', message: 'Resolution reasoning note is mandatory.' });
      return;
    }

    setIsSubmittingDecision(true);
    try {
      const res = await adminApi.decideDispute(selectedDisputeId, decisionType, resolutionText.trim());
      setActiveDispute(res.disputeCase);
      setDecisionType(null);
      setResolutionText('');
      fetchDisputes();
      setNotification({
        type: 'success',
        message: `Dispute ${decisionType.toLowerCase()} successfully.`
      });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to decide dispute'
      });
    } finally {
      setIsSubmittingDecision(false);
    }
  };

  const handleAddEvidence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDisputeId || !evidenceUrl.trim()) return;

    setIsSubmittingEvidence(true);
    try {
      await adminApi.addDisputeEvidence(selectedDisputeId, {
        type: evidenceType,
        url: evidenceUrl.trim(),
        description: evidenceDesc.trim() || undefined
      });
      // Refresh detail
      const res = await adminApi.getDisputeDetail(selectedDisputeId);
      setActiveDispute(res.disputeCase);
      setIsAddingEvidence(false);
      setEvidenceUrl('');
      setEvidenceDesc('');
      setNotification({ type: 'success', message: 'Evidence added to dispute case.' });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add evidence'
      });
    } finally {
      setIsSubmittingEvidence(false);
    }
  };

  const getDisputeBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <Badge variant="warning">Pending</Badge>;
      case 'UNDER_REVIEW':
        return <Badge variant="info">Under Review</Badge>;
      case 'RESOLVED':
        return <Badge variant="success">Resolved</Badge>;
      case 'DISMISSED':
        return <Badge variant="default">Dismissed</Badge>;
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
            Match Dispute Queue & Adjudication
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Contested matches, player claims, game state evidence, and server-authoritative resolutions.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchDisputes()}
          isLoading={isLoading}
          className="gap-1.5 h-8 text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Queue</span>
        </Button>
      </div>

      {/* Advisory Banner */}
      <div className="p-3 bg-[#0C1B2A] border border-[#18C986]/30 rounded-lg flex items-start gap-2.5 text-xs text-[#8FA3B7]">
        <Scale className="w-4 h-4 text-[#18C986] shrink-0 mt-0.5" />
        <div>
          <strong className="text-[#F5F7FA]">Authoritative Invariant:</strong> Match outcomes are server-authoritative.
          Adjudicating a dispute does not directly mutate historical match records or arbitrarily overwrite winner IDs.
          Financial remedies must be executed via balanced, double-entry ledger adjustments under <strong className="text-[#18C986]">Ledger & Transactions</strong>.
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 overflow-x-auto text-xs">
        {['ALL', 'PENDING', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'].map((st) => (
          <button
            key={st}
            onClick={() => {
              setStatusFilter(st);
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${statusFilter === st
                ? 'bg-[#18C986] text-[#000000] font-bold'
                : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
              }`}
          >
            {st === 'ALL' ? 'All Disputes' : st.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {notification && (
        <div
          className={`p-3.5 rounded-lg text-xs flex items-center justify-between ${notification.type === 'error'
              ? 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
              : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
            }`}
        >
          <span>{notification.message}</span>
          <button onClick={() => setNotification(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Disputes Table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Dispute ID</th>
                <th className="py-3 px-4">Match Context</th>
                <th className="py-3 px-4">Disputant</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Reason</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#274056]">
              {disputes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#53677A]">
                    {isLoading ? 'Loading disputes...' : 'No disputes recorded.'}
                  </td>
                </tr>
              ) : (
                disputes.map((d) => (
                  <tr key={d.id} className="hover:bg-[#132638]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                      {formatDate(d.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#F5F7FA]">
                      {d.id.slice(0, 8)}...
                    </td>
                    <td className="py-3 px-4">
                      {d.match ? (
                        <div className="space-y-0.5">
                          <span className="font-mono text-[11px] text-[#18C986]">
                            Stake: {formatNaira(d.match.stakeMinorUnits)}
                          </span>
                          <span className="block text-[10px] text-[#8FA3B7] uppercase">
                            Tier: {d.match.tier} • {d.match.status}
                          </span>
                        </div>
                      ) : (
                        <span className="font-mono text-[#8FA3B7]">Match: {d.matchId.slice(0, 8)}...</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-[#F5F7FA]">
                        {d.user?.fullName || d.user?.username || d.raisedByUser?.username || (d.userId || d.raisedBy || '').slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-[#8FA3B7] font-mono">
                        {d.user?.email || d.raisedByUser?.email || d.raisedByEmail || d.userId || d.raisedBy}
                      </div>
                    </td>
                    <td className="py-3 px-4">{getDisputeBadge(d.status)}</td>
                    <td className="py-3 px-4 text-[#F5F7FA] truncate max-w-xs">
                      {d.reason}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openDisputeDetail(d.id)}
                        className="gap-1.5 h-8 text-xs"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Adjudicate</span>
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
            Total Disputes: <strong className="text-[#F5F7FA] font-mono">{total}</strong>
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

      {/* ===================== DISPUTE DETAIL & ADJUDICATION MODAL ===================== */}
      {selectedDisputeId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Scale className="w-5 h-5 text-[#18C986]" />
                <div>
                  <h2 className="text-sm font-bold text-[#F5F7FA]">
                    Match Dispute Adjudication
                  </h2>
                  <p className="text-[11px] font-mono text-[#8FA3B7]">
                    Dispute ID: {selectedDisputeId}
                  </p>
                </div>
              </div>
              <button
                onClick={closeDisputeDetail}
                className="text-[#8FA3B7] hover:text-[#F5F7FA] p-1 rounded-md transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs text-[#F5F7FA]">
              {isDetailLoading || !activeDispute ? (
                <div className="py-16 text-center text-[#8FA3B7]">Loading dispute details...</div>
              ) : (
                <>
                  {/* Context Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Disputant Player</span>
                      <p className="font-semibold text-sm">{activeDispute.user?.fullName || activeDispute.user?.username || activeDispute.raisedByUser?.username || 'Player'}</p>
                      <p className="font-mono text-[#8FA3B7]">{activeDispute.user?.email || activeDispute.raisedByUser?.email || activeDispute.raisedByEmail || '—'}</p>
                      <p className="font-mono text-[10px] text-[#53677A]">User ID: {activeDispute.userId || activeDispute.raisedBy}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Match Information</span>
                      <p className="font-mono text-[11px] text-[#18C986]">
                        Match ID: {activeDispute.matchId.slice(0, 12)}...
                      </p>
                      {activeDispute.match && (
                        <>
                          <p className="font-mono text-[11px] text-[#F5F7FA]">
                            Stake: {formatNaira(activeDispute.match.stakeMinorUnits)}
                          </p>
                          <p className="text-[10px] text-[#8FA3B7]">
                            Tier: {activeDispute.match.tier} • Status: {activeDispute.match.status}
                          </p>
                        </>
                      )}
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Dispute State</span>
                      <div className="pt-0.5">{getDisputeBadge(activeDispute.status)}</div>
                      <p className="font-mono text-[11px] text-[#8FA3B7] pt-1">
                        Opened: {formatDate(activeDispute.createdAt)}
                      </p>
                      {activeDispute.resolvedAt && (
                        <p className="font-mono text-[10px] text-emerald-400">
                          Resolved: {formatDate(activeDispute.resolvedAt)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Disputant Claim & Reason */}
                  <div className="p-4 bg-[#000000] border border-[#274056] rounded-lg space-y-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Dispute Claim & Reason
                    </span>
                    <p className="font-semibold text-sm text-[#F5F7FA]">{activeDispute.reason}</p>
                    {activeDispute.description && (
                      <p className="text-xs text-[#8FA3B7]">{activeDispute.description}</p>
                    )}
                  </div>

                  {/* Resolution Notes (if resolved) */}
                  {activeDispute.resolution && (
                    <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg space-y-1">
                      <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                        Official Adjudication Resolution
                      </span>
                      <p className="text-xs text-[#F5F7FA]">{activeDispute.resolution}</p>
                    </div>
                  )}

                  {/* Evidence Viewer */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                        Attached Evidence ({activeDispute.evidence?.length || 0})
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setIsAddingEvidence(!isAddingEvidence)}
                        className="h-7 text-xs gap-1"
                      >
                        <FilePlus2 className="w-3.5 h-3.5 text-[#18C986]" />
                        <span>Add Evidence</span>
                      </Button>
                    </div>

                    {isAddingEvidence && (
                      <form onSubmit={handleAddEvidence} className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            placeholder="Evidence URL or reference..."
                            value={evidenceUrl}
                            onChange={(e) => setEvidenceUrl(e.target.value)}
                            required
                            className="h-8 text-xs"
                          />
                          <Input
                            placeholder="Description / note..."
                            value={evidenceDesc}
                            onChange={(e) => setEvidenceDesc(e.target.value)}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setIsAddingEvidence(false)}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="primary" type="submit" isLoading={isSubmittingEvidence}>
                            Upload Evidence
                          </Button>
                        </div>
                      </form>
                    )}

                    <div className="space-y-1.5">
                      {!activeDispute.evidence || activeDispute.evidence.length === 0 ? (
                        <p className="text-center text-[#53677A] py-4 border border-[#274056] rounded-lg">
                          No evidence attached to this dispute.
                        </p>
                      ) : (
                        activeDispute.evidence.map((ev, idx) => (
                          <div
                            key={idx}
                            className="p-2.5 bg-[#000000] border border-[#274056] rounded flex items-center justify-between text-xs"
                          >
                            <div>
                              <span className="font-semibold text-[#18C986] uppercase text-[10px] mr-2">
                                {ev.type}
                              </span>
                              <span className="font-mono text-[#F5F7FA]">{ev.url}</span>
                              {ev.description && (
                                <p className="text-[11px] text-[#8FA3B7] mt-0.5">{ev.description}</p>
                              )}
                            </div>
                            <span className="font-mono text-[10px] text-[#53677A]">
                              {formatDate(ev.createdAt)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Adjudication Action Controls */}
                  {activeDispute.status !== 'RESOLVED' && activeDispute.status !== 'DISMISSED' && (
                    <div className="border-t border-[#274056] pt-4 space-y-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                        Adjudicate Dispute Case
                      </span>

                      {!decisionType ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecisionType('RESOLVED')}
                            className="gap-1.5"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Resolve Dispute (Remedy In Order)</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setDecisionType('DISMISSED')}
                            className="gap-1.5"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Dismiss Dispute</span>
                          </Button>
                        </div>
                      ) : (
                        <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[#F5F7FA]">
                              Decision: {decisionType === 'RESOLVED' ? 'Resolve in Favor of Disputant' : 'Dismiss Dispute'}
                            </span>
                            <button
                              onClick={() => setDecisionType(null)}
                              className="text-xs text-[#8FA3B7] hover:text-[#F5F7FA]"
                            >
                              Cancel
                            </button>
                          </div>
                          <Input
                            placeholder="Enter detailed adjudication reasoning..."
                            value={resolutionText}
                            onChange={(e) => setResolutionText(e.target.value)}
                            required
                            className="h-9 text-xs"
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setDecisionType(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant={decisionType === 'DISMISSED' ? 'danger' : 'primary'}
                              onClick={handleDecideDispute}
                              isLoading={isSubmittingDecision}
                            >
                              Confirm Adjudication
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


export default function DisputesPage() {
  return (
    <RouteGuard permission={PERMISSIONS.DISPUTES_MANAGE} section="Disputes Queue">
      <DisputesPageContent />
    </RouteGuard>
  );
}
