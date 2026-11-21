'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import {
  RiskCaseItem,
  RiskEventItem,
  SaferPlayRestrictionItem,
  RiskCaseNote
} from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { formatDate, formatNaira } from '@/lib/utils';
import {
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Search,
  Eye,
  Clock,
  UserX,
  Lock,
  PlusCircle,
  X,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  FileText,
  CheckCircle2
} from 'lucide-react';

function RiskPageContent() {
  const [activeTab, setActiveTab] = useState<'CASES' | 'SAFER_PLAY'>('CASES');

  // --- TAB 1: RISK CASES & EVENTS STATE ---
  const [riskCases, setRiskCases] = useState<RiskCaseItem[]>([]);
  const [caseStatusFilter, setCaseStatusFilter] = useState('ALL');
  const [casePage, setCasePage] = useState(1);
  const [caseTotalPages, setCaseTotalPages] = useState(1);
  const [caseTotal, setCaseTotal] = useState(0);
  const [isCasesLoading, setIsCasesLoading] = useState(true);

  // Risk Case Detail Modal
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<RiskCaseItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [isSubmittingNote, setIsSubmittingNote] = useState(false);

  // --- TAB 2: SAFER PLAY RESTRICTIONS STATE ---
  const [restrictions, setRestrictions] = useState<SaferPlayRestrictionItem[]>([]);
  const [saferSearch, setSaferSearch] = useState('');
  const [saferTypeFilter, setSaferTypeFilter] = useState<'all' | 'timeout' | 'exclusion' | 'limits'>('all');
  const [saferPage, setSaferPage] = useState(1);
  const [saferTotalPages, setSaferTotalPages] = useState(1);
  const [saferTotal, setSaferTotal] = useState(0);
  const [isSaferLoading, setIsSaferLoading] = useState(true);

  // Apply Restriction Modal
  const [isApplyModalOpen, setIsApplyModalOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState('');
  const [restrictionType, setRestrictionType] = useState<'timeout' | 'exclusion' | 'limits'>('timeout');
  const [timeoutDate, setTimeoutDate] = useState('');
  const [exclusionDate, setExclusionDate] = useState('');
  const [depositLimitNaira, setDepositLimitNaira] = useState('');
  const [stakeLimitNaira, setStakeLimitNaira] = useState('');
  const [restrictionReason, setRestrictionReason] = useState('');
  const [isSubmittingRestriction, setIsSubmittingRestriction] = useState(false);

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Fetch Risk Cases
  const fetchRiskCases = useCallback((page = casePage, status = caseStatusFilter) => {
    setIsCasesLoading(true);
    adminApi.getRiskCases({
      page,
      limit: 10,
      status: status === 'ALL' ? undefined : status
    })
      .then((data) => {
        setRiskCases(data.cases || []);
        setCaseTotalPages(data.totalPages || 1);
        setCaseTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        setNotification({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to fetch risk cases'
        });
      })
      .finally(() => setIsCasesLoading(false));
  }, [casePage, caseStatusFilter]);

  // Fetch Safer Play Restrictions
  const fetchSaferPlay = useCallback((page = saferPage, query = saferSearch, type = saferTypeFilter) => {
    setIsSaferLoading(true);
    adminApi.getSaferPlayRestrictions({
      page,
      limit: 10,
      search: query.trim() || undefined,
      type
    })
      .then((data) => {
        setRestrictions(data.restrictions || []);
        setSaferTotalPages(data.totalPages || 1);
        setSaferTotal(data.total || 0);
      })
      .catch((err: unknown) => {
        setNotification({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to fetch safer play restrictions'
        });
      })
      .finally(() => setIsSaferLoading(false));
  }, [saferPage, saferSearch, saferTypeFilter]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (activeTab === 'CASES') {
        fetchRiskCases();
      } else {
        fetchSaferPlay();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [activeTab, fetchRiskCases, fetchSaferPlay]);

  // Inspect Risk Case
  const openCaseDetail = async (id: string) => {
    setSelectedCaseId(id);
    setIsDetailLoading(true);
    try {
      const res = await adminApi.getRiskCaseDetail(id);
      setActiveCase(res.riskCase);
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
    setNewNote('');
  };

  const handleAddNote = async (actionType?: string, newStatus?: 'OPEN' | 'INVESTIGATING' | 'ESCALATED' | 'RESOLVED' | 'DISMISSED') => {
    if (!selectedCaseId || (!newNote.trim() && !actionType)) return;
    setIsSubmittingNote(true);
    try {
      const res = await adminApi.addRiskCaseNote(selectedCaseId, {
        note: newNote.trim() || `Status updated to ${newStatus || actionType}`,
        actionType: actionType || 'INVESTIGATION_NOTE',
        status: newStatus
      });
      setActiveCase(res.riskCase);
      setNewNote('');
      fetchRiskCases();
      setNotification({ type: 'success', message: 'Risk case updated.' });
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update risk case'
      });
    } finally {
      setIsSubmittingNote(false);
    }
  };

  // Submit Safer Play Restriction
  const handleApplyRestriction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserId.trim()) {
      setNotification({ type: 'error', message: 'Player User ID is required.' });
      return;
    }

    setIsSubmittingRestriction(true);
    try {
      const payload: {
        timeoutUntil?: string;
        selfExcludedUntil?: string;
        depositLimitMinorUnits?: string;
        stakeLimitMinorUnits?: string;
        reason?: string;
      } = {
        reason: restrictionReason.trim() || undefined
      };

      if (restrictionType === 'timeout') {
        if (!timeoutDate) throw new Error('Please select a valid timeout end date.');
        payload.timeoutUntil = new Date(timeoutDate).toISOString();
      } else if (restrictionType === 'exclusion') {
        if (!exclusionDate) throw new Error('Please select a self-exclusion end date.');
        payload.selfExcludedUntil = new Date(exclusionDate).toISOString();
      } else if (restrictionType === 'limits') {
        if (depositLimitNaira) {
          payload.depositLimitMinorUnits = (BigInt(Math.floor(parseFloat(depositLimitNaira) * 100))).toString();
        }
        if (stakeLimitNaira) {
          payload.stakeLimitMinorUnits = (BigInt(Math.floor(parseFloat(stakeLimitNaira) * 100))).toString();
        }
      }

      await adminApi.applySaferPlayRestriction(targetUserId.trim(), payload);
      setNotification({ type: 'success', message: 'Safer play restriction applied successfully.' });
      setIsApplyModalOpen(false);
      // Reset form
      setTargetUserId('');
      setTimeoutDate('');
      setExclusionDate('');
      setDepositLimitNaira('');
      setStakeLimitNaira('');
      setRestrictionReason('');
      fetchSaferPlay();
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to apply restriction'
      });
    } finally {
      setIsSubmittingRestriction(false);
    }
  };

  const handleLiftTimeout = async (userId: string) => {
    if (!confirm('Are you sure you want to lift this timeout for the user?')) return;
    try {
      await adminApi.clearTimeout(userId);
      setNotification({ type: 'success', message: 'User timeout lifted.' });
      fetchSaferPlay();
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to lift timeout'
      });
    }
  };

  const handleEndSelfExclusion = async (userId: string) => {
    if (!confirm('WARNING: Ending self-exclusion requires strict compliance verification. Proceed?')) return;
    try {
      await adminApi.endSelfExclusion(userId);
      setNotification({ type: 'success', message: 'User self-exclusion ended.' });
      fetchSaferPlay();
    } catch (err: unknown) {
      setNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to end self-exclusion'
      });
    }
  };

  const getCaseStatusBadge = (status: string) => {
    switch (status) {
      case 'OPEN':
        return <Badge variant="warning">Open</Badge>;
      case 'INVESTIGATING':
        return <Badge variant="info">Investigating</Badge>;
      case 'ESCALATED':
        return <Badge variant="danger">Escalated</Badge>;
      case 'RESOLVED':
        return <Badge variant="success">Resolved</Badge>;
      case 'DISMISSED':
        return <Badge variant="default">Dismissed</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return <Badge variant="danger">Critical</Badge>;
      case 'HIGH':
        return <Badge variant="danger">High</Badge>;
      case 'MEDIUM':
        return <Badge variant="warning">Medium</Badge>;
      case 'LOW':
        return <Badge variant="default">Low</Badge>;
      default:
        return <Badge variant="default">{severity}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-[#274056]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            Risk & Safer Play Management
          </h1>
          <p className="text-xs text-[#8FA3B7] mt-0.5">
            Collusion detection, velocity alerts, safer-play restrictions, and compliance interventions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'SAFER_PLAY' && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setIsApplyModalOpen(true)}
              className="gap-1.5 h-8 text-xs font-semibold"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Apply Restriction</span>
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (activeTab === 'CASES' ? fetchRiskCases() : fetchSaferPlay())}
            isLoading={isCasesLoading || isSaferLoading}
            className="gap-1.5 h-8 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[#274056] pb-2 text-xs">
        <button
          onClick={() => setActiveTab('CASES')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-colors ${
            activeTab === 'CASES'
              ? 'bg-[#18C986] text-[#000000]'
              : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
          }`}
        >
          <ShieldAlert className="w-4 h-4" />
          <span>Risk Events & Cases ({caseTotal})</span>
        </button>
        <button
          onClick={() => setActiveTab('SAFER_PLAY')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-colors ${
            activeTab === 'SAFER_PLAY'
              ? 'bg-[#18C986] text-[#000000]'
              : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
          }`}
        >
          <Lock className="w-4 h-4" />
          <span>Safer Play Profiles & Limits ({saferTotal})</span>
        </button>
      </div>

      {notification && (
        <div
          className={`p-3.5 rounded-lg text-xs flex items-center justify-between ${
            notification.type === 'error'
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

      {/* ===================== TAB 1: RISK CASES ===================== */}
      {activeTab === 'CASES' && (
        <div className="space-y-4">
          {/* Status filters */}
          <div className="flex gap-1.5 overflow-x-auto text-xs">
            {['ALL', 'OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED', 'DISMISSED'].map((st) => (
              <button
                key={st}
                onClick={() => {
                  setCaseStatusFilter(st);
                  setCasePage(1);
                }}
                className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
                  caseStatusFilter === st
                    ? 'bg-[#18C986] text-[#000000] font-bold'
                    : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
                }`}
              >
                {st === 'ALL' ? 'All Risk Cases' : st}
              </button>
            ))}
          </div>

          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Created</th>
                    <th className="py-3 px-4">Subject Player</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Assigned To</th>
                    <th className="py-3 px-4">Events</th>
                    <th className="py-3 px-4">Updated</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#274056]">
                  {riskCases.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-[#53677A]">
                        {isCasesLoading ? 'Loading risk cases...' : 'No risk cases recorded.'}
                      </td>
                    </tr>
                  ) : (
                    riskCases.map((rc) => (
                      <tr key={rc.id} className="hover:bg-[#132638]/40 transition-colors">
                        <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                          {formatDate(rc.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-[#F5F7FA]">
                            {rc.subject?.fullName || rc.subject?.username || rc.subject?.email || rc.subjectId}
                          </div>
                          <div className="text-[11px] text-[#8FA3B7] font-mono">
                            {rc.subject?.email || rc.subjectId}
                          </div>
                        </td>
                        <td className="py-3 px-4">{getCaseStatusBadge(rc.status)}</td>
                        <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                          {rc.assignedTo || 'Unassigned'}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-[#18C986]">
                          {rc.events ? rc.events.length : 0} events
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-[#53677A]">
                          {formatDate(rc.updatedAt)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openCaseDetail(rc.id)}
                            className="gap-1.5 h-8 text-xs"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Investigate</span>
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-[#0C1B2A] border-t border-[#274056] flex items-center justify-between text-xs text-[#8FA3B7]">
              <span>
                Total Cases: <strong className="text-[#F5F7FA] font-mono">{caseTotal}</strong>
              </span>
              <div className="flex items-center gap-2">
                <span>Page {casePage} of {caseTotalPages}</span>
                <div className="flex gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={casePage <= 1}
                    onClick={() => setCasePage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={casePage >= caseTotalPages}
                    onClick={() => setCasePage((p) => p + 1)}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ===================== TAB 2: SAFER PLAY ===================== */}
      {activeTab === 'SAFER_PLAY' && (
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            <div className="flex gap-1.5 text-xs">
              {(['all', 'timeout', 'exclusion', 'limits'] as const).map((filterKey) => (
                <button
                  key={filterKey}
                  onClick={() => {
                    setSaferTypeFilter(filterKey);
                    setSaferPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-lg font-medium capitalize transition-colors ${
                    saferTypeFilter === filterKey
                      ? 'bg-[#18C986] text-[#000000] font-bold'
                      : 'bg-[#0C1B2A] text-[#8FA3B7] hover:text-[#F5F7FA] border border-[#274056]'
                  }`}
                >
                  {filterKey}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSaferPage(1);
                fetchSaferPlay(1, saferSearch, saferTypeFilter);
              }}
              className="flex items-center gap-2 max-w-sm"
            >
              <Input
                placeholder="Search user email, username..."
                value={saferSearch}
                onChange={(e) => setSaferSearch(e.target.value)}
                className="h-9 text-xs"
              >
              </Input>
              <Button type="submit" size="sm" variant="secondary" className="shrink-0 h-9 px-3">
                <Search className="w-3.5 h-3.5" />
              </Button>
            </form>
          </div>

          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#132638] text-[#8FA3B7] border-b border-[#274056] uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Player</th>
                    <th className="py-3 px-4">Timeout Status</th>
                    <th className="py-3 px-4">Self-Exclusion</th>
                    <th className="py-3 px-4">Deposit Limit</th>
                    <th className="py-3 px-4">Stake Limit</th>
                    <th className="py-3 px-4 text-right">Intervention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#274056]">
                  {restrictions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-[#53677A]">
                        {isSaferLoading ? 'Loading safer play restrictions...' : 'No safer play profiles found.'}
                      </td>
                    </tr>
                  ) : (
                    restrictions.map((r) => {
                      const isTimedOut = r.timeoutUntil && new Date(r.timeoutUntil) > new Date();
                      const isExcluded = r.selfExcludedUntil && new Date(r.selfExcludedUntil) > new Date();

                      return (
                        <tr key={r.id} className="hover:bg-[#132638]/40 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-[#F5F7FA]">
                              {r.user?.fullName || r.user?.username || r.user?.email || r.userId}
                            </div>
                            <div className="text-[11px] text-[#8FA3B7] font-mono">
                              {r.user?.email || r.userId}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            {isTimedOut ? (
                              <div className="space-y-0.5">
                                <Badge variant="warning">Timed Out</Badge>
                                <span className="block text-[10px] text-[#8FA3B7] font-mono">
                                  Until {formatDate(r.timeoutUntil)}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[#53677A]">None</span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            {isExcluded ? (
                              <div className="space-y-0.5">
                                <Badge variant="danger">Self-Excluded</Badge>
                                <span className="block text-[10px] text-[#8FA3B7] font-mono">
                                  Until {formatDate(r.selfExcludedUntil)}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[#53677A]">None</span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono text-[#F5F7FA]">
                            {r.depositLimitMinorUnits ? formatNaira(r.depositLimitMinorUnits) : 'No Limit'}
                          </td>
                          <td className="py-3 px-4 font-mono text-[#F5F7FA]">
                            {r.stakeLimitMinorUnits ? formatNaira(r.stakeLimitMinorUnits) : 'No Limit'}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex gap-1.5">
                              {isTimedOut && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => handleLiftTimeout(r.userId)}
                                  className="h-7 text-[11px]"
                                >
                                  Lift Timeout
                                </Button>
                              )}
                              {isExcluded && (
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => handleEndSelfExclusion(r.userId)}
                                  className="h-7 text-[11px]"
                                >
                                  End Exclusion
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-[#0C1B2A] border-t border-[#274056] flex items-center justify-between text-xs text-[#8FA3B7]">
              <span>
                Total Profiles: <strong className="text-[#F5F7FA] font-mono">{saferTotal}</strong>
              </span>
              <div className="flex items-center gap-2">
                <span>Page {saferPage} of {saferTotalPages}</span>
                <div className="flex gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saferPage <= 1}
                    onClick={() => setSaferPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saferPage >= saferTotalPages}
                    onClick={() => setSaferPage((p) => p + 1)}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ===================== RISK CASE INVESTIGATION DRAWER ===================== */}
      {selectedCaseId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-5 h-5 text-rose-400" />
                <div>
                  <h2 className="text-sm font-bold text-[#F5F7FA]">
                    Risk Investigation Case Detail
                  </h2>
                  <p className="text-[11px] font-mono text-[#8FA3B7]">
                    Case ID: {selectedCaseId}
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
                <div className="py-16 text-center text-[#8FA3B7]">Loading risk case detail...</div>
              ) : (
                <>
                  {/* Subject Details */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Subject Account</span>
                      <p className="font-semibold text-sm">{activeCase.subject?.fullName || activeCase.subject?.username || 'No display name'}</p>
                      <p className="font-mono text-[#8FA3B7]">{activeCase.subject?.email}</p>
                      <p className="font-mono text-[11px] text-[#53677A]">ID: {activeCase.subjectId}</p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Case Status & Escalation</span>
                      <div className="pt-0.5">{getCaseStatusBadge(activeCase.status)}</div>
                      <p className="text-[11px] text-[#8FA3B7] pt-1">
                        Assigned: <strong className="text-[#F5F7FA] font-mono">{activeCase.assignedTo || 'Unassigned'}</strong>
                      </p>
                    </div>

                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-1">
                      <span className="text-[10px] uppercase text-[#8FA3B7] font-semibold">Timeline</span>
                      <p className="font-mono text-[#8FA3B7]">Opened: {formatDate(activeCase.createdAt)}</p>
                      <p className="font-mono text-[#8FA3B7]">Updated: {formatDate(activeCase.updatedAt)}</p>
                    </div>
                  </div>

                  {/* Associated Risk Events */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Flagged Risk Signals & Events ({activeCase.events?.length || 0})
                    </h3>
                    <div className="border border-[#274056] rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#132638] text-[#8FA3B7] uppercase text-[10px]">
                          <tr>
                            <th className="py-2 px-3">Timestamp</th>
                            <th className="py-2 px-3">Type</th>
                            <th className="py-2 px-3">Severity</th>
                            <th className="py-2 px-3">Metadata</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#274056]">
                          {!activeCase.events || activeCase.events.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="py-4 text-center text-[#53677A]">
                                No explicit risk events linked.
                              </td>
                            </tr>
                          ) : (
                            activeCase.events.map((evt) => (
                              <tr key={evt.id} className="hover:bg-[#132638]/20">
                                <td className="py-2 px-3 font-mono text-[#8FA3B7]">{formatDate(evt.createdAt)}</td>
                                <td className="py-2 px-3 font-semibold text-[#F5F7FA]">{evt.type}</td>
                                <td className="py-2 px-3">{getSeverityBadge(evt.severity)}</td>
                                <td className="py-2 px-3 font-mono text-[10px] text-[#8FA3B7] truncate max-w-xs">
                                  {evt.metadata ? JSON.stringify(evt.metadata) : '—'}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Investigation Notes & Log */}
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Investigation Notes & Operator Action Log
                    </h3>
                    <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg max-h-48 overflow-y-auto space-y-2">
                      {Array.isArray(activeCase.notes) && activeCase.notes.length > 0 ? (
                        (activeCase.notes as RiskCaseNote[]).map((n, idx) => (
                          <div key={idx} className="p-2 bg-[#0C1B2A] border border-[#274056] rounded text-xs space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-[#8FA3B7]">
                              <span className="font-semibold text-[#18C986]">{n.actionType || 'NOTE'}</span>
                              <span className="font-mono">{formatDate(n.createdAt)}</span>
                            </div>
                            <p className="text-[#F5F7FA]">{n.note}</p>
                          </div>
                        ))
                      ) : (
                        <p className="text-center text-[#53677A] py-4">No investigation notes entered yet.</p>
                      )}
                    </div>
                  </div>

                  {/* Case Actions */}
                  <div className="border-t border-[#274056] pt-4 space-y-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                      Add Investigation Note / Update Status
                    </span>
                    <Input
                      placeholder="Add confidential investigation note..."
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      className="h-9 text-xs"
                    />
                    <div className="flex flex-wrap gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleAddNote('INVESTIGATION_NOTE')}
                        isLoading={isSubmittingNote}
                      >
                        Add Note Only
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleAddNote('STATUS_CHANGE', 'INVESTIGATING')}
                        isLoading={isSubmittingNote}
                      >
                        Set to Investigating
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleAddNote('ESCALATION', 'ESCALATED')}
                        isLoading={isSubmittingNote}
                        className="gap-1.5"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>Escalate Case</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => handleAddNote('RESOLUTION', 'RESOLVED')}
                        isLoading={isSubmittingNote}
                        className="gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Resolve Case</span>
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===================== APPLY SAFER PLAY RESTRICTION MODAL ===================== */}
      {isApplyModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-lg w-full shadow-2xl overflow-hidden">
            <div className="p-4 bg-[#132638] border-b border-[#274056] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#18C986]" />
                <h3 className="text-sm font-bold text-[#F5F7FA]">Apply Safer Play Restriction</h3>
              </div>
              <button
                onClick={() => setIsApplyModalOpen(false)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleApplyRestriction} className="p-5 space-y-4 text-xs">
              <Input
                label="Player User ID"
                placeholder="UUID of target player..."
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                required
              />

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                  Restriction Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['timeout', 'exclusion', 'limits'] as const).map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setRestrictionType(t)}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold capitalize transition-colors ${
                        restrictionType === t
                          ? 'bg-[#18C986] text-[#000000] border-[#18C986]'
                          : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {restrictionType === 'timeout' && (
                <Input
                  label="Timeout End Date & Time"
                  type="datetime-local"
                  value={timeoutDate}
                  onChange={(e) => setTimeoutDate(e.target.value)}
                  required
                />
              )}

              {restrictionType === 'exclusion' && (
                <Input
                  label="Self-Exclusion End Date & Time"
                  type="datetime-local"
                  value={exclusionDate}
                  onChange={(e) => setExclusionDate(e.target.value)}
                  required
                />
              )}

              {restrictionType === 'limits' && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Deposit Limit (₦)"
                    type="number"
                    step="1"
                    placeholder="e.g. 50000"
                    value={depositLimitNaira}
                    onChange={(e) => setDepositLimitNaira(e.target.value)}
                  />
                  <Input
                    label="Stake Limit (₦)"
                    type="number"
                    step="1"
                    placeholder="e.g. 10000"
                    value={stakeLimitNaira}
                    onChange={(e) => setStakeLimitNaira(e.target.value)}
                  />
                </div>
              )}

              <Input
                label="Compliance Reason / Investigation Reference"
                placeholder="Regulatory or player protection reason..."
                value={restrictionReason}
                onChange={(e) => setRestrictionReason(e.target.value)}
              />

              <p className="text-[11px] text-[#8FA3B7]">
                Safer play restrictions enforce extend-only logic: active timeouts and self-exclusions cannot be shortened.
              </p>

              <div className="flex justify-end gap-2 pt-2 border-t border-[#274056]">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsApplyModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  isLoading={isSubmittingRestriction}
                >
                  Confirm Restriction
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


export default function RiskPage() {
  return (
    <RouteGuard permission={PERMISSIONS.RISK_REVIEW} section="Risk & Safer Play">
      <RiskPageContent />
    </RouteGuard>
  );
}
