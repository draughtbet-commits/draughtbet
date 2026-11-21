'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { SupportCaseItem } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  LifeBuoy,
  RefreshCw,
  Search,
  PlusCircle,
  Eye,
  MessageSquare,
  CheckCircle2,
  X,
  ChevronLeft,
  ChevronRight,
  Send
} from 'lucide-react';

function SupportPageContent() {
  const [cases, setCases] = useState<SupportCaseItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [priorityFilter] = useState('ALL');
  const [categoryFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // New Case Modal State
  const [isNewCaseOpen, setIsNewCaseOpen] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategory, setNewCategory] = useState('ACCOUNT');
  const [newPriority, setNewPriority] = useState('MEDIUM');
  const [newMatchId, setNewMatchId] = useState('');
  const [newTxRef, setNewTxRef] = useState('');
  const [isSubmittingNewCase, setIsSubmittingNewCase] = useState(false);

  // Case Detail Modal State
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<SupportCaseItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [internalNoteText, setInternalNoteText] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [resolutionText, setResolutionText] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchCases = useCallback(async (
    targetPage = page,
    status = statusFilter,
    priority = priorityFilter,
    category = categoryFilter,
    query = search
  ) => {
    try {
      const data = await adminApi.getSupportCases({
        page: targetPage,
        limit: 10,
        status: status === 'ALL' ? undefined : status,
        priority: priority === 'ALL' ? undefined : priority,
        category: category === 'ALL' ? undefined : category,
        search: query.trim() || undefined
      });
      setCases(data.cases || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to fetch support cases'
      });
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter, priorityFilter, categoryFilter, search]);

  useEffect(() => {
    void (async () => {
      await fetchCases();
    })();
  }, [fetchCases]);

  const openCaseDetail = async (id: string) => {
    setSelectedCaseId(id);
    setIsDetailLoading(true);
    setInternalNoteText('');
    setResolutionText('');
    try {
      const res = await adminApi.getSupportCaseDetail(id);
      setActiveCase(res.supportCase);
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load case detail'
      });
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeCaseDetail = () => {
    setSelectedCaseId(null);
    setActiveCase(null);
  };

  const handleCreateCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserId.trim() || !newSubject.trim() || !newDescription.trim()) {
      setNotification({ type: 'error', message: 'User ID, subject, and description are required.' });
      return;
    }

    setIsSubmittingNewCase(true);
    try {
      await adminApi.createSupportCase({
        userId: newUserId.trim(),
        subject: newSubject.trim(),
        description: newDescription.trim(),
        category: newCategory,
        priority: newPriority,
        relatedMatchId: newMatchId.trim() || undefined,
        relatedTransactionRef: newTxRef.trim() || undefined
      });
      setNotification({ type: 'success', message: 'Support case created successfully.' });
      setIsNewCaseOpen(false);
      setNewUserId('');
      setNewSubject('');
      setNewDescription('');
      setNewMatchId('');
      setNewTxRef('');
      fetchCases();
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create support case'
      });
    } finally {
      setIsSubmittingNewCase(false);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCaseId || !internalNoteText.trim()) return;

    setIsAddingNote(true);
    try {
      const res = await adminApi.updateSupportCase(selectedCaseId, {
        note: internalNoteText.trim()
      });
      setActiveCase(res.supportCase);
      setInternalNoteText('');
      setNotification({ type: 'success', message: 'Internal note added to support case.' });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add note'
      });
    } finally {
      setIsAddingNote(false);
    }
  };

  const handleUpdateStatus = async (newStatus: string) => {
    if (!selectedCaseId) return;
    try {
      const res = await adminApi.updateSupportCase(selectedCaseId, {
        status: newStatus
      });
      setActiveCase(res.supportCase);
      fetchCases();
      setNotification({ type: 'success', message: `Case status changed to ${newStatus}.` });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update status'
      });
    }
  };

  const handleResolveCase = async () => {
    if (!selectedCaseId || !resolutionText.trim()) {
      setNotification({ type: 'error', message: 'Resolution note is required.' });
      return;
    }
    setIsResolving(true);
    try {
      const res = await adminApi.updateSupportCase(selectedCaseId, {
        status: 'RESOLVED',
        resolutionNote: resolutionText.trim()
      });
      setActiveCase(res.supportCase);
      fetchCases();
      setResolutionText('');
      setNotification({ type: 'success', message: 'Support case resolved.' });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to resolve case'
      });
    } finally {
      setIsResolving(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'OPEN':
        return <Badge variant="warning">Open</Badge>;
      case 'IN_PROGRESS':
        return <Badge variant="info">In Progress</Badge>;
      case 'WAITING_ON_PLAYER':
        return <Badge variant="gold">Waiting on Player</Badge>;
      case 'ESCALATED':
        return <Badge variant="danger">Escalated</Badge>;
      case 'RESOLVED':
        return <Badge variant="success">Resolved</Badge>;
      case 'CLOSED':
        return <Badge variant="default">Closed</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'URGENT':
        return <Badge variant="danger">Urgent</Badge>;
      case 'HIGH':
        return <Badge variant="danger">High</Badge>;
      case 'MEDIUM':
        return <Badge variant="warning">Medium</Badge>;
      case 'LOW':
        return <Badge variant="default">Low</Badge>;
      default:
        return <Badge variant="default">{priority}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            Customer Support Directory
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Player inquiries, ticket triage, dispute linkages, and internal operator notes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => setIsNewCaseOpen(true)}
            className="gap-1.5 h-8 text-xs font-semibold"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>Open New Case</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchCases()}
            isLoading={isLoading}
            className="gap-1.5 h-8 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Advisory Banner */}
      <div className="p-3 bg-[#0C1B2A] border border-[#274056] rounded-lg flex items-start gap-2.5 text-xs text-[#8FA3B7]">
        <LifeBuoy className="w-4 h-4 text-[#18C986] shrink-0 mt-0.5" />
        <div>
          Support agents can assign, escalate, and record resolution notes for player inquiries.
          <strong className="text-[#F5F7FA]"> Ledger Integrity Rule:</strong> Support agents do not have direct ledger modification access. Any financial adjustments must be escalated to Finance operators.
        </div>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="flex gap-1.5 overflow-x-auto text-xs pb-1">
          {['ALL', 'OPEN', 'IN_PROGRESS', 'WAITING_ON_PLAYER', 'ESCALATED', 'RESOLVED', 'CLOSED'].map((st) => (
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
              {st === 'ALL' ? 'All Tickets' : st.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            fetchCases(1, statusFilter, priorityFilter, categoryFilter, search);
          }}
          className="flex items-center gap-2 max-w-sm"
        >
          <Input
            placeholder="Search ref, email, subject..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" className="shrink-0 h-9 px-3">
            <Search className="w-3.5 h-3.5" />
          </Button>
        </form>
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

      {/* Cases Table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Reference</th>
                <th className="py-3 px-4">Subject</th>
                <th className="py-3 px-4">Customer</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Priority</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#274056]">
              {cases.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-[#53677A]">
                    {isLoading ? 'Loading support cases...' : 'No support cases recorded.'}
                  </td>
                </tr>
              ) : (
                cases.map((sc) => (
                  <tr key={sc.id} className="hover:bg-[#132638]/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                      {formatDate(sc.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-[11px] text-[#18C986]">
                      {sc.reference}
                    </td>
                    <td className="py-3 px-4 font-semibold text-[#F5F7FA] max-w-xs truncate">
                      {sc.subject}
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-[#F5F7FA]">
                        {sc.user?.fullName || sc.user?.username || sc.userId.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-[#8FA3B7] font-mono">
                        {sc.user?.email || sc.userId}
                      </div>
                    </td>
                    <td className="py-3 px-4 uppercase text-[10px] text-[#8FA3B7]">
                      {sc.category.replace(/_/g, ' ')}
                    </td>
                    <td className="py-3 px-4">{getPriorityBadge(sc.priority)}</td>
                    <td className="py-3 px-4">{getStatusBadge(sc.status)}</td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openCaseDetail(sc.id)}
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
            Total Cases: <strong className="text-[#F5F7FA] font-mono">{total}</strong>
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

      {/* ===================== NEW SUPPORT CASE MODAL ===================== */}
      {isNewCaseOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-lg w-full shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PlusCircle className="w-4 h-4 text-[#18C986]" />
                <h3 className="text-sm font-bold text-[#F5F7FA]">Open New Support Case</h3>
              </div>
              <button
                onClick={() => setIsNewCaseOpen(false)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateCase} className="p-5 space-y-3.5 text-xs">
              <Input
                label="Player User ID"
                placeholder="UUID of player..."
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                required
              />

              <Input
                label="Subject Line"
                placeholder="Brief summary of inquiry..."
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                required
              />

              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                  Description
                </label>
                <textarea
                  rows={3}
                  className="w-full p-2.5 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] focus:border-[#18C986] focus:outline-none"
                  placeholder="Detailed customer claim or inquiry..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                    Category
                  </label>
                  <select
                    className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] focus:border-[#18C986] focus:outline-none"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                  >
                    <option value="ACCOUNT">Account</option>
                    <option value="MATCH_DISPUTE">Match Dispute</option>
                    <option value="DEPOSIT">Deposit</option>
                    <option value="WITHDRAWAL">Withdrawal</option>
                    <option value="KYC_COMPLIANCE">KYC Compliance</option>
                    <option value="TECHNICAL">Technical</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                    Priority
                  </label>
                  <select
                    className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] focus:border-[#18C986] focus:outline-none"
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Related Match ID (Optional)"
                  placeholder="UUID if game-related..."
                  value={newMatchId}
                  onChange={(e) => setNewMatchId(e.target.value)}
                />
                <Input
                  label="Transaction Ref (Optional)"
                  placeholder="Payment / withdrawal reference..."
                  value={newTxRef}
                  onChange={(e) => setNewTxRef(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-[#274056]">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsNewCaseOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  isLoading={isSubmittingNewCase}
                >
                  Create Case
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===================== CASE DETAIL & NOTES MODAL ===================== */}
      {selectedCaseId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <LifeBuoy className="w-5 h-5 text-[#18C986]" />
                <div>
                  <h2 className="text-sm font-bold text-[#F5F7FA]">
                    Support Case Details
                  </h2>
                  <p className="text-[11px] font-mono text-[#18C986]">
                    {activeCase?.reference || selectedCaseId}
                  </p>
                </div>
              </div>
              <button
                onClick={closeCaseDetail}
                className="text-[#8FA3B7] hover:text-[#F5F7FA] p-1 rounded-md transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs text-[#F5F7FA]">
              {isDetailLoading || !activeCase ? (
                <div className="py-16 text-center text-[#8FA3B7]">Loading support case...</div>
              ) : (
                <>
                  {/* Context Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Customer Account</span>
                      <p className="font-semibold text-sm">{activeCase.user?.fullName || activeCase.user?.username || 'No display name'}</p>
                      <p className="font-mono text-[#8FA3B7]">{activeCase.user?.email}</p>
                      <p className="text-[10px] text-[#53677A]">User ID: {activeCase.userId}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Classification & Urgency</span>
                      <div className="flex items-center gap-2 pt-0.5">
                        {getStatusBadge(activeCase.status)}
                        {getPriorityBadge(activeCase.priority)}
                      </div>
                      <p className="text-[11px] text-[#8FA3B7] pt-1">
                        Category: <strong className="text-[#F5F7FA] uppercase">{activeCase.category}</strong>
                      </p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Timestamps</span>
                      <p className="font-mono text-[#8FA3B7]">Opened: {formatDate(activeCase.createdAt)}</p>
                      <p className="font-mono text-[#8FA3B7]">Updated: {formatDate(activeCase.updatedAt)}</p>
                    </div>
                  </div>

                  {/* Subject & Description */}
                  <div className="p-4 bg-[#000000] border border-[#274056] rounded-lg space-y-1.5">
                    <span className="text-[10px] uppercase font-bold text-[#8FA3B7]">Customer Inquiry</span>
                    <h3 className="font-bold text-sm text-[#F5F7FA]">{activeCase.subject}</h3>
                    <p className="text-xs text-[#8FA3B7] whitespace-pre-wrap">{activeCase.description}</p>
                  </div>

                  {/* Resolution Notes (if resolved) */}
                  {activeCase.resolutionNote && (
                    <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg space-y-1">
                      <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                        Resolution Summary
                      </span>
                      <p className="text-xs text-[#F5F7FA]">{activeCase.resolutionNote}</p>
                    </div>
                  )}

                  {/* Timeline Notes */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7] flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5 text-[#18C986]" />
                      <span>Case Timeline & Internal Notes ({activeCase.notes?.length || 0})</span>
                    </h3>
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg max-h-48 overflow-y-auto space-y-2">
                      {!activeCase.notes || activeCase.notes.length === 0 ? (
                        <p className="text-center text-[#53677A] py-3">No timeline notes recorded.</p>
                      ) : (
                        activeCase.notes.map((nt) => (
                          <div key={nt.id} className="p-2 bg-[#0C1B2A] border border-[#274056] rounded space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-[#8FA3B7]">
                              <span className="font-semibold text-[#18C986]">{nt.eventType}</span>
                              <span className="font-mono">{formatDate(nt.createdAt)}</span>
                            </div>
                            <p className="text-xs text-[#F5F7FA]">{nt.body}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Add Internal Note */}
                  <form onSubmit={handleAddNote} className="space-y-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Add Internal Operator Note
                    </span>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Type confidential operator note..."
                        value={internalNoteText}
                        onChange={(e) => setInternalNoteText(e.target.value)}
                        className="h-9 text-xs"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        isLoading={isAddingNote}
                        className="shrink-0 gap-1"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Post Note</span>
                      </Button>
                    </div>
                  </form>

                  {/* Status & Resolution Controls */}
                  <div className="border-t border-[#274056] pt-4 space-y-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Status Transitions
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {activeCase.status !== 'IN_PROGRESS' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleUpdateStatus('IN_PROGRESS')}
                        >
                          Mark In Progress
                        </Button>
                      )}
                      {activeCase.status !== 'WAITING_ON_PLAYER' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleUpdateStatus('WAITING_ON_PLAYER')}
                        >
                          Waiting on Player
                        </Button>
                      )}
                      {activeCase.status !== 'ESCALATED' && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleUpdateStatus('ESCALATED')}
                        >
                          Escalate Case
                        </Button>
                      )}
                      {activeCase.status !== 'CLOSED' && activeCase.status !== 'RESOLVED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUpdateStatus('CLOSED')}
                        >
                          Close Without Resolution
                        </Button>
                      )}
                    </div>

                    {activeCase.status !== 'RESOLVED' && (
                      <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-2">
                        <span className="font-bold text-xs text-[#F5F7FA]">Resolve Support Ticket</span>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Enter final resolution note..."
                            value={resolutionText}
                            onChange={(e) => setResolutionText(e.target.value)}
                            className="h-9 text-xs"
                          />
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={handleResolveCase}
                            isLoading={isResolving}
                            className="shrink-0 gap-1.5"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Resolve</span>
                          </Button>
                        </div>
                      </div>
                    )}
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


export default function SupportPage() {
  return (
    <RouteGuard permission={PERMISSIONS.USERS_MANAGE} section="Support Cases">
      <SupportPageContent />
    </RouteGuard>
  );
}
