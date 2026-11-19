'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import { PlatformConfigVersionItem } from '@/lib/api/types';
import { ConfigDiffViewer } from '@/components/configuration/ConfigDiffViewer';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  CheckSquare,
  CheckCircle2,
  XCircle,
  Zap,
  ShieldAlert,
  Lock,
  RefreshCw,
  AlertTriangle,
  UserCheck,
  Hash,
  ArrowRight,
  X
} from 'lucide-react';

export default function ConfigurationApprovalsPage() {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.CONFIG_READ);
  const canApprove = canAccessPermission(user, PERMISSIONS.CONFIG_APPROVE);
  const canActivate = canAccessPermission(user, PERMISSIONS.CONFIG_ACTIVATE);

  const [versions, setVersions] = useState<PlatformConfigVersionItem[]>([]);
  const [activeVersion, setActiveVersion] = useState<PlatformConfigVersionItem | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PlatformConfigVersionItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Review inputs
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isActivating, setIsActivating] = useState(false);

  const loadApprovalsQueue = useCallback(async () => {
    setError(null);
    setPermissionDenied(false);
    try {
      const [activeRes, versionsRes] = await Promise.all([
        adminApi.getActiveConfig(),
        adminApi.getConfigVersions({ page: 1, limit: 40 })
      ]);

      setActiveVersion(activeRes.config);
      const all = versionsRes.versions || [];
      setVersions(all);

      const firstPending =
        all.find((v) => v.status === 'PENDING_APPROVAL') ||
        all.find((v) => v.status === 'APPROVED') ||
        null;

      if (firstPending) {
        const detail = await adminApi.getConfigVersion(firstPending.version);
        setSelectedVersion(detail.version);
      } else {
        setSelectedVersion(null);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setPermissionDenied(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load approval queue');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadApprovalsQueue();
    })();
  }, [loadApprovalsQueue]);

  const pendingQueue = useMemo(
    () => versions.filter((v) => v.status === 'PENDING_APPROVAL'),
    [versions]
  );

  const approvedQueue = useMemo(
    () => versions.filter((v) => v.status === 'APPROVED'),
    [versions]
  );

  const reviewedHistory = useMemo(
    () =>
      versions.filter(
        (v) =>
          (v.approvals && v.approvals.length > 0) ||
          v.status === 'REJECTED' ||
          v.status === 'ACTIVE' ||
          v.status === 'SUPERSEDED'
      ),
    [versions]
  );

  const handleSelectVersionForReview = async (v: PlatformConfigVersionItem) => {
    setIsLoadingDetail(true);
    setReviewNote('');
    setRejectionReason('');
    try {
      const res = await adminApi.getConfigVersion(v.version);
      setSelectedVersion(res.version);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load version payload for review'
      });
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const isCallerProposer = Boolean(
    user && selectedVersion && selectedVersion.authorId === user.id
  );

  const handleApproveProposal = async () => {
    if (!selectedVersion) return;
    setIsApproving(true);
    setBanner(null);
    try {
      const res = await adminApi.approveConfigVersion(selectedVersion.id, {
        reviewNote: reviewNote.trim() || 'Verified SHA-256 payload and domain diff',
        checksum: selectedVersion.checksum
      });
      setReviewNote('');
      await loadApprovalsQueue();
      setSelectedVersion(res.version);
      setBanner({
        type: 'success',
        message: `Configuration Version v${res.version.version} APPROVED with bound SHA-256 checksum (${res.approval.checksum.slice(
          0,
          14
        )}…). Ready for atomic activation.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Maker-checker approval failed'
      });
    } finally {
      setIsApproving(false);
    }
  };

  const handleRejectProposal = async () => {
    if (!selectedVersion) return;
    if (rejectionReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A detailed rejection reason (minimum 5 characters) is mandatory.'
      });
      return;
    }

    setIsRejecting(true);
    setBanner(null);
    try {
      const res = await adminApi.rejectConfigVersion(
        selectedVersion.id,
        rejectionReason.trim()
      );
      setShowRejectModal(false);
      setRejectionReason('');
      await loadApprovalsQueue();
      setSelectedVersion(res.version);
      setBanner({
        type: 'info',
        message: `Configuration Version v${res.version.version} REJECTED and recorded in audit trail.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Rejection failed'
      });
    } finally {
      setIsRejecting(false);
    }
  };

  const handleActivateApprovedVersion = async (v: PlatformConfigVersionItem) => {
    setIsActivating(true);
    setBanner(null);
    try {
      const res = await adminApi.activateConfigVersion(v.id);
      await loadApprovalsQueue();
      window.dispatchEvent(new CustomEvent('draughtbet:config-updated'));
      setBanner({
        type: 'success',
        message: `Version v${res.version.version} is now ACTIVE! Previous active configuration superseded, legacy PlatformSettings synchronized, and transactional outbox event enqueued.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Atomic activation failed'
      });
    } finally {
      setIsActivating(false);
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
              Inspecting the Maker-Checker approval queue requires <code className="font-mono text-[#18C986]">config.read</code>.
              Approving/rejecting requires <code className="font-mono text-[#18C986]">config.approve</code>.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Maker-Checker Lifecycle Header */}
      <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <Badge variant="default">1. DRAFT</Badge>
            <ArrowRight className="w-3.5 h-3.5 text-[#53677A]" />
            <Badge variant="warning">2. PENDING_APPROVAL ({pendingQueue.length})</Badge>
            <ArrowRight className="w-3.5 h-3.5 text-[#53677A]" />
            <Badge variant="info">3. APPROVED ({approvedQueue.length}) / REJECTED</Badge>
            <ArrowRight className="w-3.5 h-3.5 text-[#53677A]" />
            <Badge variant="success">4. ACTIVE (v{activeVersion?.version ?? 1})</Badge>
          </div>
          <p className="text-xs text-[#8FA3B7]">
            Author/Reviewer separation is strictly enforced on the backend (<code className="font-mono">authorId !== reviewerId</code>).
            Every approval binds the reviewer&apos;s sign-off to the exact RFC 8785 SHA-256 payload checksum.
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setIsLoading(true);
            void loadApprovalsQueue();
          }}
          isLoading={isLoading}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Queue
        </Button>
      </div>

      {error && (
        <Card className="p-4 border-rose-500/30 text-xs text-rose-300">{error}</Card>
      )}

      {banner && (
        <div
          role="status"
          className={`rounded-xl p-4 border flex items-center justify-between text-xs ${
            banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : banner.type === 'error'
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
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

      {/* Main Split View: Left Queue List + Right Approval Detail & Diff */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Pending & Approved Queues */}
        <div className="space-y-6">
          <Card className="space-y-3">
            <CardHeader>
              <div>
                <CardTitle>Pending Approval Queue ({pendingQueue.length})</CardTitle>
                <CardDescription>Proposals awaiting independent Maker-Checker review.</CardDescription>
              </div>
              <Badge variant="warning">{pendingQueue.length}</Badge>
            </CardHeader>

            {pendingQueue.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#53677A]">
                No proposals are currently awaiting approval.
              </div>
            ) : (
              <div className="space-y-2.5">
                {pendingQueue.map((item) => {
                  const isSelected = selectedVersion?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectVersionForReview(item)}
                      className={`w-full text-left rounded-xl p-3.5 border transition-colors space-y-1.5 ${
                        isSelected
                          ? 'bg-[#0E2E2B]/35 border-[#18C986]'
                          : 'bg-[#000000] border-[#274056] hover:bg-[#132638]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-sm text-[#F5F7FA]">
                          Version v{item.version}
                        </span>
                        <Badge variant="warning">PENDING_APPROVAL</Badge>
                      </div>
                      <p className="text-xs text-[#F5F7FA] font-medium line-clamp-2">
                        {item.changeReason}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {item.modifiedDomains?.map((d) => (
                          <span
                            key={d}
                            className="px-1.5 py-0.5 rounded bg-[#0C1B2A] border border-[#274056] font-mono text-[10px] text-[#18C986]"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[#8FA3B7] pt-1">
                        <span>Proposer: {item.author?.email || item.authorId.slice(0, 8)}</span>
                        <span className="font-mono">{formatDate(item.createdAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="space-y-3">
            <CardHeader>
              <div>
                <CardTitle>Approved &amp; Ready to Activate ({approvedQueue.length})</CardTitle>
                <CardDescription>Verified proposals ready for atomic activation.</CardDescription>
              </div>
              <Badge variant="info">{approvedQueue.length}</Badge>
            </CardHeader>

            {approvedQueue.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#53677A]">
                No approved versions awaiting activation.
              </div>
            ) : (
              <div className="space-y-2.5">
                {approvedQueue.map((item) => {
                  const isSelected = selectedVersion?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() => handleSelectVersionForReview(item)}
                      className={`cursor-pointer rounded-xl p-3.5 border transition-colors space-y-2 ${
                        isSelected
                          ? 'bg-[#0E2E2B]/35 border-[#18C986]'
                          : 'bg-[#000000] border-[#274056] hover:bg-[#132638]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-sm text-[#F5F7FA]">
                          Version v{item.version}
                        </span>
                        <Badge variant="info">APPROVED</Badge>
                      </div>
                      <p className="text-xs text-[#F5F7FA] line-clamp-2">{item.changeReason}</p>
                      <div className="flex items-center justify-between pt-1">
                        <span className="font-mono text-[10px] text-[#8FA3B7]">
                          SHA: {item.checksum.slice(0, 12)}…
                        </span>
                        {canActivate && (
                          <Button
                            variant="primary"
                            size="sm"
                            isLoading={isActivating}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleActivateApprovedVersion(item);
                            }}
                          >
                            <Zap className="w-3.5 h-3.5" />
                            Activate Now
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Right 2 Columns: Approval Detail, Checksum Verification & Structured Diff */}
        <div className="lg:col-span-2 space-y-6">
          {!selectedVersion ? (
            <Card className="p-12 text-center space-y-2">
              <CheckSquare className="w-10 h-10 text-[#18C986] mx-auto opacity-60" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                Select a Configuration Proposal to Review
              </h3>
              <p className="text-xs text-[#8FA3B7] max-w-md mx-auto">
                Choose a version from the Pending Approval queue, Approved queue, or Approval History below to inspect its SHA-256 checksum and domain diff.
              </p>
            </Card>
          ) : isLoadingDetail ? (
            <Card className="p-12 text-center text-xs text-[#8FA3B7]">
              Loading proposal payload and verifying SHA-256 checksum…
            </Card>
          ) : (
            <Card className="space-y-5">
              <CardHeader className="border-b border-[#274056] pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-lg">
                      Proposal Review: Version v{selectedVersion.version}
                    </CardTitle>
                    <Badge
                      variant={
                        selectedVersion.status === 'PENDING_APPROVAL'
                          ? 'warning'
                          : selectedVersion.status === 'APPROVED'
                            ? 'info'
                            : selectedVersion.status === 'ACTIVE'
                              ? 'success'
                              : 'danger'
                      }
                    >
                      {selectedVersion.status}
                    </Badge>
                    {selectedVersion.isRestricted && (
                      <Badge variant="gold">Restricted Maker-Checker Proposal</Badge>
                    )}
                  </div>
                  <CardDescription className="mt-1">
                    {selectedVersion.changeReason}
                  </CardDescription>
                </div>
              </CardHeader>

              {/* Metadata & Checksum Verification Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="bg-[#000000] border border-[#274056] rounded-xl p-4 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <UserCheck className="w-4 h-4 text-[#18C986]" />
                    <span>Proposer &amp; Maker-Checker Identity</span>
                  </div>
                  <div className="flex justify-between text-[#8FA3B7]">
                    <span>Proposer (Author):</span>
                    <span className="font-mono text-[#F5F7FA]">
                      {selectedVersion.author?.email || selectedVersion.authorId}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#8FA3B7]">
                    <span>Submitted / Created:</span>
                    <span className="font-mono text-[#F5F7FA]">
                      {formatDate(selectedVersion.updatedAt || selectedVersion.createdAt)}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#8FA3B7]">
                    <span>Current Reviewer:</span>
                    <span className="font-mono text-[#18C986]">{user?.email || '—'}</span>
                  </div>
                </div>

                <div className="bg-[#000000] border border-[#274056] rounded-xl p-4 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <Hash className="w-4 h-4 text-emerald-400" />
                    <span>Cryptographic Checksum Binding (SHA-256)</span>
                  </div>
                  <div className="font-mono text-[11px] text-[#18C986] break-all">
                    {selectedVersion.checksum}
                  </div>
                  <p className="text-[11px] text-[#8FA3B7]">
                    This SHA-256 digest is computed from the RFC 8785 canonical JSON payload and bound to your approval record.
                  </p>
                </div>
              </div>

              {/* Self-Approval Prohibition Alert */}
              {selectedVersion.status === 'PENDING_APPROVAL' && isCallerProposer && (
                <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 flex items-start gap-3 text-xs">
                  <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="font-bold text-amber-300">
                      Maker-Checker Separation: Self-Approval Prohibited
                    </div>
                    <p className="text-[#F5F7FA]/90">
                      You authored Proposal v{selectedVersion.version} (<code className="font-mono">{user?.email}</code>).
                      Per platform governance rules (enforced by <code className="font-mono">ConfigService.approveVersion</code>),
                      an independent reviewer holding <code className="font-mono">config.approve</code> must review and
                      approve or reject this proposal.
                    </p>
                  </div>
                </div>
              )}

              {/* Approval / Rejection Controls for PENDING_APPROVAL */}
              {selectedVersion.status === 'PENDING_APPROVAL' && canApprove && (
                <div className="bg-[#132638] border border-[#274056] rounded-xl p-4 space-y-4">
                  <div className="text-xs font-bold uppercase tracking-wider text-[#F5F7FA]">
                    Independent Checker Decision (`config.approve`)
                  </div>

                  <Input
                    label="Approval Review Note (Optional)"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    placeholder="e.g., Verified tier stake bounds and commission against Q4 approval memo"
                  />

                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={isCallerProposer || isApproving}
                      onClick={() => {
                        setRejectionReason('');
                        setShowRejectModal(true);
                      }}
                    >
                      <XCircle className="w-4 h-4" />
                      Reject Proposal…
                    </Button>

                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isCallerProposer || isRejecting}
                      isLoading={isApproving}
                      onClick={handleApproveProposal}
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Approve Version v{selectedVersion.version} (Bind Checksum)
                    </Button>
                  </div>
                </div>
              )}

              {/* Activation Control for APPROVED version */}
              {selectedVersion.status === 'APPROVED' && (
                <div className="bg-sky-500/10 border border-sky-500/30 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                  <div className="space-y-1">
                    <div className="font-bold text-sky-300">
                      Version v{selectedVersion.version} is APPROVED and Checksum-Verified
                    </div>
                    <p className="text-[#8FA3B7]">
                      Activating this version will atomically supersede Active v{activeVersion?.version ?? 1}, update{' '}
                      <code className="font-mono">PlatformSettings</code>, and broadcast an outbox cache invalidation event.
                    </p>
                  </div>

                  {canActivate ? (
                    <Button
                      variant="primary"
                      size="sm"
                      isLoading={isActivating}
                      onClick={() => handleActivateApprovedVersion(selectedVersion)}
                    >
                      <Zap className="w-4 h-4" />
                      Activate Version v{selectedVersion.version}
                    </Button>
                  ) : (
                    <Badge variant="default">Requires `config.activate` (SUPER_ADMIN)</Badge>
                  )}
                </div>
              )}

              {/* Structured Domain Diff against Active Baseline */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#8FA3B7]">
                  Configuration Diff: Active v{activeVersion?.version ?? 1} → Proposal v{selectedVersion.version}
                </h4>
                <ConfigDiffViewer
                  basePayload={activeVersion?.payload}
                  targetPayload={selectedVersion.payload}
                  baseLabel={`Active (v${activeVersion?.version ?? 1})`}
                  targetLabel={`Proposal (v${selectedVersion.version})`}
                />
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Approval History Table */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Maker-Checker Approval &amp; Review History</CardTitle>
            <CardDescription>
              Historical log of all configuration proposals, reviewer sign-offs, bound checksums, and outcomes.
            </CardDescription>
          </div>
        </CardHeader>

        {reviewedHistory.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#53677A]">
            No reviewed configuration versions recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                  <th className="py-2.5 px-4">Version</th>
                  <th className="py-2.5 px-4">Current Status</th>
                  <th className="py-2.5 px-4">Proposer</th>
                  <th className="py-2.5 px-4">Reviewer &amp; Decision</th>
                  <th className="py-2.5 px-4">Review Note / Reason</th>
                  <th className="py-2.5 px-4">Bound Checksum</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056] text-xs">
                {reviewedHistory.map((v) => {
                  const appr = v.approvals?.[0];
                  return (
                    <tr key={v.id} className="hover:bg-[#132638]/60">
                      <td className="py-3 px-4 font-mono font-bold text-[#F5F7FA]">v{v.version}</td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={
                            v.status === 'ACTIVE'
                              ? 'success'
                              : v.status === 'APPROVED'
                                ? 'info'
                                : v.status === 'REJECTED'
                                  ? 'danger'
                                  : 'default'
                          }
                        >
                          {v.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 font-mono text-[#8FA3B7]">
                        {v.author?.email || v.authorId.slice(0, 8)}
                      </td>
                      <td className="py-3 px-4">
                        {appr ? (
                          <div>
                            <Badge variant={appr.status === 'APPROVED' ? 'success' : 'danger'}>
                              {appr.status}
                            </Badge>
                            <span className="ml-2 font-mono text-[#F5F7FA]">
                              {appr.reviewer?.email || appr.reviewerId.slice(0, 8)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[#53677A]">Bootstrap / Direct</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[#8FA3B7]">
                        {appr?.reviewNote || v.changeReason}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-[#18C986]">
                        {(appr?.checksum || v.checksum)?.slice(0, 14)}…
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSelectVersionForReview(v)}
                        >
                          Inspect Diff
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Reject Proposal Modal */}
      {showRejectModal && selectedVersion && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-rose-500/40 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-rose-400">
              <XCircle className="w-5 h-5" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                Reject Proposal v{selectedVersion.version}
              </h3>
            </div>
            <p className="text-xs text-[#8FA3B7]">
              Rejecting transitions v{selectedVersion.version} to <code className="font-mono">REJECTED</code> status.
              Provide a clear reason (minimum 5 characters) for the proposer and audit trail.
            </p>
            <Input
              label="Mandatory Rejection Reason (Min 5 Characters)"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Proposed Master tier stake ceiling exceeds approved Q4 risk appetite"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRejectModal(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleRejectProposal}
                isLoading={isRejecting}
              >
                Confirm Rejection
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
