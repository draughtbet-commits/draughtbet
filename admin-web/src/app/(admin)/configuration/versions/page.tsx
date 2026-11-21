'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission, canProposeAnyConfig } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import {
  PlatformConfigVersionItem,
  ConfigVersionStatus
} from '@/lib/api/types';
import { ConfigDiffViewer } from '@/components/configuration/ConfigDiffViewer';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  History,
  GitCompare,
  RotateCcw,
  Eye,
  Send,
  Zap,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Lock,
  Search,
  X
} from 'lucide-react';

export default function ConfigurationVersionsPage() {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.CONFIG_READ);
  const canPropose = canProposeAnyConfig(user);
  const canActivate = canAccessPermission(user, PERMISSIONS.CONFIG_ACTIVATE);

  const [versions, setVersions] = useState<PlatformConfigVersionItem[]>([]);
  const [activeVersion, setActiveVersion] = useState<PlatformConfigVersionItem | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [isLoading, setIsLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const [statusFilter, setStatusFilter] = useState<ConfigVersionStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Version Detail Modal
  const [inspectedVersion, setInspectedVersion] = useState<PlatformConfigVersionItem | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Version Comparison state
  const [compareLeftNum, setCompareLeftNum] = useState<number>(1);
  const [compareRightNum, setCompareRightNum] = useState<number>(1);
  const [compareLeftDetail, setCompareLeftDetail] = useState<PlatformConfigVersionItem | null>(null);
  const [compareRightDetail, setCompareRightDetail] = useState<PlatformConfigVersionItem | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  // Rollback Modal
  const [rollbackTarget, setRollbackTarget] = useState<PlatformConfigVersionItem | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [isRollingBack, setIsRollingBack] = useState(false);

  const [isSubmittingDraftId, setIsSubmittingDraftId] = useState<string | null>(null);
  const [isActivatingId, setIsActivatingId] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    setError(null);
    setPermissionDenied(false);
    try {
      const [activeRes, histRes] = await Promise.all([
        adminApi.getActiveConfig(),
        adminApi.getConfigVersions({ page, limit: 20, status: statusFilter })
      ]);

      setActiveVersion(activeRes.config);
      const list = histRes.versions || [];
      setVersions(list);
      setTotal(histRes.total || list.length);
      setTotalPages(histRes.totalPages || 1);

      if (list.length > 0 && activeRes.config) {
        setCompareLeftNum((prev) => prev || activeRes.config.version);
        setCompareRightNum((prev) => prev || list[0].version);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setPermissionDenied(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load configuration version history');
      }
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    (async () => {
      await loadVersions();
    })();
  }, [loadVersions]);

  const filteredVersions = useMemo(() => {
    if (!searchQuery.trim()) return versions;
    const q = searchQuery.trim().toLowerCase();
    return versions.filter(
      (v) =>
        `v${v.version}`.includes(q) ||
        String(v.version) === q ||
        v.changeReason?.toLowerCase().includes(q) ||
        v.checksum?.toLowerCase().includes(q) ||
        v.author?.email?.toLowerCase().includes(q) ||
        v.modifiedDomains?.some((d) => d.toLowerCase().includes(q))
    );
  }, [versions, searchQuery]);

  const handleInspectVersion = async (v: PlatformConfigVersionItem) => {
    setIsLoadingDetail(true);
    setInspectedVersion(v);
    try {
      const res = await adminApi.getConfigVersion(v.version);
      if (res.version) {
        setInspectedVersion(res.version);
      }
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load full version payload'
      });
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleRunComparison = async () => {
    setIsComparing(true);
    setBanner(null);
    try {
      const [leftRes, rightRes] = await Promise.all([
        adminApi.getConfigVersion(compareLeftNum),
        adminApi.getConfigVersion(compareRightNum)
      ]);
      setCompareLeftDetail(leftRes.version);
      setCompareRightDetail(rightRes.version);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load versions for comparison'
      });
    } finally {
      setIsComparing(false);
    }
  };

  const handleSubmitDraft = async (v: PlatformConfigVersionItem) => {
    setIsSubmittingDraftId(v.id);
    setBanner(null);
    try {
      const res = await adminApi.submitConfigDraft(v.id);
      await loadVersions();
      setBanner({
        type: 'success',
        message: `Draft v${res.version.version} submitted for Maker-Checker review (Status: ${res.version.status}).`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to submit draft'
      });
    } finally {
      setIsSubmittingDraftId(null);
    }
  };

  const handleActivateVersion = async (v: PlatformConfigVersionItem) => {
    setIsActivatingId(v.id);
    setBanner(null);
    try {
      const res = await adminApi.activateConfigVersion(v.id, {
        expectedVersion: v.version,
        expectedChecksum: v.checksum
      });
      await loadVersions();
      window.dispatchEvent(new CustomEvent('draughtbet:config-updated'));
      setBanner({
        type: 'success',
        message: `Configuration Version v${res.version.version} atomically activated! Previous active version superseded and Redis cache invalidated via transactional outbox.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to activate version'
      });
    } finally {
      setIsActivatingId(null);
    }
  };

  const handleConfirmRollback = async () => {
    if (!rollbackTarget) return;
    if (rollbackReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A rollback reason of at least 5 characters is required.'
      });
      return;
    }

    setIsRollingBack(true);
    setBanner(null);
    try {
      const res = await adminApi.rollbackConfigVersion(
        rollbackTarget.version,
        rollbackReason.trim()
      );
      setRollbackTarget(null);
      setRollbackReason('');
      await loadVersions();
      setBanner({
        type: 'success',
        message: `Non-destructive rollback staged as new Draft v${res.version.version} (cloned from historical v${res.version.rolledBackFrom}). Submit it for approval to activate.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to stage rollback version'
      });
    } finally {
      setIsRollingBack(false);
    }
  };

  const getStatusBadge = (status: ConfigVersionStatus) => {
    switch (status) {
      case 'ACTIVE':
        return <Badge variant="success">ACTIVE</Badge>;
      case 'APPROVED':
        return <Badge variant="info">APPROVED</Badge>;
      case 'PENDING_APPROVAL':
        return <Badge variant="warning">PENDING APPROVAL</Badge>;
      case 'DRAFT':
        return <Badge variant="default">DRAFT</Badge>;
      case 'REJECTED':
        return <Badge variant="danger">REJECTED</Badge>;
      case 'SUPERSEDED':
        return <Badge variant="default">SUPERSEDED</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  if (permissionDenied || (!canRead && !isLoading)) {
    return (
      <Card className="p-8 border-amber-500/30">
        <div className="flex items-start gap-4">
          <Lock className="w-6 h-6 text-amber-400 shrink-0" />
          <div className="space-y-2">
            <h2 className="text-base font-bold text-[#F5F7FA]">
              Configuration Read Permission Required (`config.read`)
            </h2>
            <p className="text-xs text-[#8FA3B7]">
              Viewing configuration version history requires <code className="font-mono text-[#18C986]">config.read</code>.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Immutability & Non-Destructive Rollback Notice */}
      <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-[#18C986] shrink-0 mt-0.5" />
          <div className="text-xs space-y-0.5">
            <div className="font-bold text-[#F5F7FA]">
              Immutable Configuration Ledger &amp; Non-Destructive Rollback
            </div>
            <p className="text-[#8FA3B7]">
              Submitted (<code className="font-mono">PENDING_APPROVAL</code>), <code className="font-mono">APPROVED</code>,{' '}
              <code className="font-mono">ACTIVE</code>, <code className="font-mono">SUPERSEDED</code>, and{' '}
              <code className="font-mono">REJECTED</code> versions are permanently immutable and cryptographically
              bound to their RFC 8785 SHA-256 checksum. Rolling back to a historical version creates a brand-new
              sequential version (<code className="font-mono">N+1</code>) carrying a <code className="font-mono">rolledBackFrom</code> pointer.
            </p>
          </div>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setIsLoading(true);
            void loadVersions();
          }}
          isLoading={isLoading}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh History
        </Button>
      </div>

      {banner && (
        <div
          role="status"
          className={`rounded-xl p-4 border flex items-center justify-between text-xs ${banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}
        >
          <div className="flex items-center gap-2">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-4 h-4" />
            )}
            <span>{banner.message}</span>
          </div>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Interactive Version Comparison Panel */}
      <Card className="space-y-4">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <GitCompare className="w-5 h-5 text-[#18C986]" />
            <div>
              <CardTitle>Structured Before-and-After Version Comparison</CardTitle>
              <CardDescription>
                Compare any two configuration versions domain-by-domain with NGN Naira/kobo formatting.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
              Baseline Version (Left)
            </label>
            <select
              aria-label="Select baseline version for comparison"
              value={compareLeftNum}
              onChange={(e) => setCompareLeftNum(Number.parseInt(e.target.value, 10))}
              className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA]"
            >
              {versions.map((v) => (
                <option key={`left-${v.id}`} value={v.version}>
                  v{v.version} ({v.status}) — {v.changeReason.slice(0, 40)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
              Target Version (Right)
            </label>
            <select
              aria-label="Select target version for comparison"
              value={compareRightNum}
              onChange={(e) => setCompareRightNum(Number.parseInt(e.target.value, 10))}
              className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA]"
            >
              {versions.map((v) => (
                <option key={`right-${v.id}`} value={v.version}>
                  v{v.version} ({v.status}) — {v.changeReason.slice(0, 40)}
                </option>
              ))}
            </select>
          </div>

          <Button variant="primary" onClick={handleRunComparison} isLoading={isComparing}>
            <GitCompare className="w-4 h-4" />
            Compare v{compareLeftNum} → v{compareRightNum}
          </Button>
        </div>

        {compareLeftDetail && compareRightDetail && (
          <div className="pt-2">
            <ConfigDiffViewer
              basePayload={compareLeftDetail.payload}
              targetPayload={compareRightDetail.payload}
              baseLabel={`v${compareLeftDetail.version} (${compareLeftDetail.status})`}
              targetLabel={`v${compareRightDetail.version} (${compareRightDetail.status})`}
            />
          </div>
        )}
      </Card>

      {/* Version History Table */}
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle>Configuration Version Timeline ({total})</CardTitle>
            <CardDescription>
              Complete history of drafts, submitted proposals, approvals, activations, and rollbacks.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 text-[#53677A] absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search versions…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-9 pr-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
              />
            </div>

            <select
              aria-label="Filter version history by status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as ConfigVersionStatus | '');
                setPage(1);
              }}
              className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
              <option value="APPROVED">APPROVED</option>
              <option value="DRAFT">DRAFT</option>
              <option value="SUPERSEDED">SUPERSEDED</option>
              <option value="REJECTED">REJECTED</option>
            </select>
          </div>
        </CardHeader>

        {error ? (
          <div className="py-8 text-center text-xs text-rose-400">{error}</div>
        ) : isLoading ? (
          <div className="py-10 text-center text-xs text-[#8FA3B7]">Loading version history…</div>
        ) : filteredVersions.length === 0 ? (
          <div className="py-10 text-center text-xs text-[#53677A]">
            No configuration versions match your filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                  <th className="py-3 px-4">Version</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Change Summary &amp; Domains</th>
                  <th className="py-3 px-4">Author &amp; Approvals</th>
                  <th className="py-3 px-4">SHA-256 Checksum</th>
                  <th className="py-3 px-4">Lifecycle Dates</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056] text-xs">
                {filteredVersions.map((v) => {
                  const latestApproval = v.approvals?.[0];
                  return (
                    <tr key={v.id} className="hover:bg-[#132638]/60">
                      <td className="py-3.5 px-4 align-top font-mono font-bold text-[#F5F7FA]">
                        v{v.version}
                        {v.rolledBackFrom && (
                          <span className="block text-[10px] text-amber-400 font-normal">
                            ↶ Rollback of v{v.rolledBackFrom}
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 align-top">
                        {getStatusBadge(v.status)}
                        {v.isRestricted && (
                          <div className="text-[10px] text-[#18C986] font-medium mt-1">
                            Maker-Checker Required
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 align-top max-w-xs">
                        <div className="text-[#F5F7FA] font-medium">{v.changeReason}</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {v.modifiedDomains?.length > 0 ? (
                            v.modifiedDomains.map((d) => (
                              <span
                                key={d}
                                className="px-1.5 py-0.5 rounded bg-[#000000] border border-[#274056] font-mono text-[10px] text-[#8FA3B7]"
                              >
                                {d}
                              </span>
                            ))
                          ) : (
                            <span className="text-[10px] text-[#53677A]">Baseline / Full Snapshot</span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top text-[11px]">
                        <div className="text-[#F5F7FA]">
                          Author: <span className="font-mono">{v.author?.email || v.authorId.slice(0, 8)}</span>
                        </div>
                        {latestApproval && (
                          <div className="text-[#8FA3B7] mt-0.5">
                            Reviewer ({latestApproval.status}):{' '}
                            <span className="font-mono text-[#18C986]">
                              {latestApproval.reviewer?.email || latestApproval.reviewerId.slice(0, 8)}
                            </span>
                          </div>
                        )}
                        {v.activatedBy && (
                          <div className="text-emerald-400 mt-0.5">
                            Activated by: <span className="font-mono">{v.activatedBy.email}</span>
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 align-top font-mono text-[11px] text-[#18C986]">
                        <span title={v.checksum}>{v.checksum?.slice(0, 14)}…</span>
                      </td>

                      <td className="py-3.5 px-4 align-top font-mono text-[11px] text-[#8FA3B7] space-y-0.5">
                        <div>Created: {formatDate(v.createdAt)}</div>
                        {v.activatedAt && (
                          <div className="text-emerald-400">Activated: {formatDate(v.activatedAt)}</div>
                        )}
                        {v.supersededAt && (
                          <div className="text-[#53677A]">Superseded: {formatDate(v.supersededAt)}</div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 align-top text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleInspectVersion(v)}
                          >
                            <Eye className="w-3.5 h-3.5" />
                            Inspect
                          </Button>

                          {v.status === 'DRAFT' && canPropose && (
                            <Button
                              variant="primary"
                              size="sm"
                              isLoading={isSubmittingDraftId === v.id}
                              onClick={() => handleSubmitDraft(v)}
                            >
                              <Send className="w-3.5 h-3.5" />
                              Submit
                            </Button>
                          )}

                          {v.status === 'PENDING_APPROVAL' && (
                            <Link href={`/configuration/approvals?version=${v.version}`}>
                              <Button variant="outline" size="sm">Review</Button>
                            </Link>
                          )}

                          {v.status === 'APPROVED' && canActivate && (
                            <Button
                              variant="primary"
                              size="sm"
                              isLoading={isActivatingId === v.id}
                              onClick={() => handleActivateVersion(v)}
                            >
                              <Zap className="w-3.5 h-3.5" />
                              Activate
                            </Button>
                          )}

                          {canActivate && v.status !== 'DRAFT' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRollbackReason(`Rollback to configuration version v${v.version}`);
                                setRollbackTarget(v);
                              }}
                              title={`Stage non-destructive rollback from v${v.version}`}
                            >
                              <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                              Rollback
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 mt-4 border-t border-[#274056] text-xs text-[#8FA3B7]">
            <span>
              Page {page} of {totalPages} ({total} total versions)
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Version Detail &Diff Inspection Modal */}
      {inspectedVersion && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <div className="flex items-center gap-3">
                <History className="w-5 h-5 text-[#18C986]" />
                <div>
                  <h3 className="text-base font-bold text-[#F5F7FA]">
                    Configuration Version v{inspectedVersion.version} Detail
                  </h3>
                  <p className="text-xs font-mono text-[#8FA3B7]">
                    SHA-256: {inspectedVersion.checksum}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectedVersion(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-4">
              {isLoadingDetail ? (
                <div className="py-10 text-center text-xs text-[#8FA3B7]">
                  Verifying SHA-256 integrity and loading payload…
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[#000000] border border-[#274056] rounded-xl p-4 text-xs">
                    <div>
                      <span className="text-[#8FA3B7] block">Status:</span>
                      <div className="mt-1">{getStatusBadge(inspectedVersion.status)}</div>
                    </div>
                    <div>
                      <span className="text-[#8FA3B7] block">Author:</span>
                      <span className="font-mono text-[#F5F7FA]">
                        {inspectedVersion.author?.email || inspectedVersion.authorId}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#8FA3B7] block">Change Reason:</span>
                      <span className="text-[#F5F7FA] font-medium">{inspectedVersion.changeReason}</span>
                    </div>
                  </div>

                  {/* Approval History */}
                  {inspectedVersion.approvals && inspectedVersion.approvals.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                        Maker-Checker Review Records
                      </h4>
                      <div className="space-y-2">
                        {inspectedVersion.approvals.map((a) => (
                          <div
                            key={a.id}
                            className="bg-[#000000] border border-[#274056] rounded-lg p-3 text-xs flex flex-wrap items-center justify-between gap-2"
                          >
                            <div>
                              <Badge variant={a.status === 'APPROVED' ? 'success' : 'danger'}>
                                {a.status}
                              </Badge>
                              <span className="ml-2 text-[#F5F7FA] font-mono">
                                Reviewer: {a.reviewer?.email || a.reviewerId}
                              </span>
                              {a.reviewNote && (
                                <p className="text-[#8FA3B7] mt-1 italic">&ldquo;{a.reviewNote}&rdquo;</p>
                              )}
                            </div>
                            <div className="text-right font-mono text-[11px] text-[#53677A]">
                              <div>Bound Checksum: {a.checksum?.slice(0, 14)}…</div>
                              <div>{formatDate(a.reviewedAt || a.createdAt)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Diff against Active Version */}
                  {inspectedVersion.payload && activeVersion?.payload && (
                    <ConfigDiffViewer
                      basePayload={activeVersion.payload}
                      targetPayload={inspectedVersion.payload}
                      baseLabel={`Active (v${activeVersion.version})`}
                      targetLabel={`Inspected (v${inspectedVersion.version})`}
                      defaultShowUnchanged={true}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Non-Destructive Rollback Confirmation Modal */}
      {rollbackTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-amber-400">
              <RotateCcw className="w-5 h-5" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                Stage Non-Destructive Rollback to v{rollbackTarget.version}
              </h3>
            </div>
            <p className="text-xs text-[#8FA3B7]">
              Historical version <strong className="font-mono text-[#F5F7FA]">v{rollbackTarget.version}</strong> remains
              strictly immutable. This action creates a brand-new sequential configuration version (
              <code className="font-mono">N+1</code>) in <code className="font-mono">DRAFT</code> status using the
              verified payload and SHA-256 checksum of <code className="font-mono">v{rollbackTarget.version}</code>,
              with <code className="font-mono">rolledBackFrom = {rollbackTarget.version}</code>.
            </p>

            <Input
              label="Mandatory Rollback Reason (Min 5 Characters)"
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              placeholder="Explain why you are rolling back to this historical configuration"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setRollbackTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirmRollback}
                isLoading={isRollingBack}
              >
                Create Rollback Draft
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
