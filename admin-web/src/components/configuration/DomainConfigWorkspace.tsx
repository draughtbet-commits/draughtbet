'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission, canProposeDomain } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import {
  ConfigDomainName,
  PlatformConfigPayload,
  PlatformConfigVersionItem,
  ValidateConfigDraftResponse
} from '@/lib/api/types';
import {
  CONFIG_DOMAIN_METADATA,
  DEFAULT_CONFIG_PAYLOAD,
  computeConfigDiff
} from '@/lib/config/diff';
import { ConfigDiffViewer } from './ConfigDiffViewer';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  FileEdit,
  Send,
  Trash2,
  RotateCcw,
  Lock,
  History,
  CheckSquare,
  Sparkles,
  X
} from 'lucide-react';

export interface DomainRenderProps {
  activePayload: PlatformConfigPayload;
  draftPayload: PlatformConfigPayload;
  updateDraftPayload: (updater: (prev: PlatformConfigPayload) => PlatformConfigPayload) => void;
  canEdit: boolean;
  isDirty: boolean;
  fieldErrors: Record<string, string>;
}

export interface DomainConfigWorkspaceProps {
  domains: ConfigDomainName[];
  title: string;
  subtitle: string;
  impactNotice: string;
  children: (props: DomainRenderProps) => React.ReactNode;
}

export function DomainConfigWorkspace({
  domains,
  title,
  subtitle,
  impactNotice,
  children
}: DomainConfigWorkspaceProps) {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.CONFIG_READ);
  const canEdit = useMemo(
    () => Boolean(user && domains.every((d) => canProposeDomain(user, d))),
    [user, domains]
  );

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [activeVersion, setActiveVersion] = useState<PlatformConfigVersionItem | null>(null);
  const [recentVersions, setRecentVersions] = useState<PlatformConfigVersionItem[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string>('NEW');

  const [activePayload, setActivePayload] = useState<PlatformConfigPayload>(DEFAULT_CONFIG_PAYLOAD);
  const [draftPayload, setDraftPayload] = useState<PlatformConfigPayload>(DEFAULT_CONFIG_PAYLOAD);
  const [changeReason, setChangeReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');

  const [validationResult, setValidationResult] = useState<ValidateConfigDraftResponse | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [actionBanner, setActionBanner] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const loadConfigurationData = useCallback(async (preserveDraftEdits = false) => {
    setLoadError(null);
    setPermissionDenied(false);
    try {
      const [activeRes, historyRes] = await Promise.all([
        adminApi.getActiveConfig(),
        adminApi.getConfigVersions({ page: 1, limit: 25 })
      ]);

      const activeCfg = activeRes.config;
      const resolvedPayload = activeCfg?.payload
        ? structuredClone(activeCfg.payload)
        : structuredClone(DEFAULT_CONFIG_PAYLOAD);

      setActiveVersion(activeCfg);
      setActivePayload(resolvedPayload);
      setRecentVersions(historyRes.versions || []);

      if (!preserveDraftEdits) {
        setDraftPayload(structuredClone(resolvedPayload));
        setSelectedDraftId('NEW');
        setChangeReason('');
        setEffectiveFrom('');
        setValidationResult(null);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setPermissionDenied(true);
      } else {
        setLoadError(err instanceof Error ? err.message : 'Failed to load configuration state');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await loadConfigurationData(false);
    })();
    const handleRealtimeRefresh = () => {
      if (mounted) {
        void loadConfigurationData(true);
      }
    };
    window.addEventListener('draughtbet:config-updated', handleRealtimeRefresh);
    return () => {
      mounted = false;
      window.removeEventListener('draughtbet:config-updated', handleRealtimeRefresh);
    };
  }, [loadConfigurationData]);

  const diffSummary = useMemo(
    () => computeConfigDiff(activePayload, draftPayload),
    [activePayload, draftPayload]
  );

  const isDirty = diffSummary.totalChanged > 0 || diffSummary.totalAdded > 0 || diffSummary.totalRemoved > 0;

  // Warn before closing tab with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const availableDrafts = useMemo(
    () => recentVersions.filter((v) => v.status === 'DRAFT'),
    [recentVersions]
  );

  const pendingApprovalsCount = useMemo(
    () => recentVersions.filter((v) => v.status === 'PENDING_APPROVAL').length,
    [recentVersions]
  );

  const handleSelectDraft = async (draftIdOrNew: string) => {
    setActionBanner(null);
    setValidationResult(null);
    if (draftIdOrNew === 'NEW') {
      setSelectedDraftId('NEW');
      setDraftPayload(structuredClone(activePayload));
      setChangeReason('');
      setEffectiveFrom('');
      return;
    }

    const found = availableDrafts.find((d) => d.id === draftIdOrNew);
    if (!found) return;

    try {
      const detail = await adminApi.getConfigVersion(found.version);
      if (detail.version?.payload) {
        setSelectedDraftId(detail.version.id);
        setDraftPayload(structuredClone(detail.version.payload));
        setChangeReason(detail.version.changeReason || '');
        setEffectiveFrom(
          detail.version.effectiveFrom
            ? new Date(detail.version.effectiveFrom).toISOString().slice(0, 16)
            : ''
        );
      }
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load selected draft payload'
      });
    }
  };

  const updateDraftPayload = useCallback(
    (updater: (prev: PlatformConfigPayload) => PlatformConfigPayload) => {
      setDraftPayload((prev) => {
        const clone = structuredClone(prev);
        return updater(clone);
      });
      setValidationResult(null);
    },
    []
  );

  const fieldErrors = useMemo(() => {
    const map: Record<string, string> = {};
    if (validationResult && !validationResult.valid && Array.isArray(validationResult.errors)) {
      for (const issue of validationResult.errors) {
        const pathKey = Array.isArray(issue.path) ? issue.path.join('.') : '';
        if (pathKey && !map[pathKey]) {
          map[pathKey] = issue.message;
        }
      }
    }
    return map;
  }, [validationResult]);

  const handleValidateDraft = async () => {
    setIsValidating(true);
    setActionBanner(null);
    try {
      const res = await adminApi.validateConfigDraft(draftPayload, activeVersion?.version ?? null);
      setValidationResult(res);
      if (res.valid) {
        setActionBanner({
          type: 'info',
          message: `Payload validated by server. Canonical SHA-256: ${res.checksum?.slice(0, 16)}... (${
            res.isRestricted ? 'Requires Maker-Checker Approval' : 'Standard Operational Change'
          })`
        });
      } else {
        setActionBanner({
          type: 'error',
          message: `Validation failed with ${res.errors?.length || 1} constraint violation(s).`
        });
      }
      return res;
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Server validation request failed'
      });
      return null;
    } finally {
      setIsValidating(false);
    }
  };

  const handleSaveDraftOnly = async () => {
    if (changeReason.trim().length < 5) {
      setActionBanner({
        type: 'error',
        message: 'A detailed change reason (minimum 5 characters) is required to save a configuration draft.'
      });
      return;
    }

    setIsSaving(true);
    setActionBanner(null);
    try {
      const valRes = await adminApi.validateConfigDraft(draftPayload, activeVersion?.version ?? null);
      setValidationResult(valRes);
      if (!valRes.valid) {
        setActionBanner({
          type: 'error',
          message: 'Cannot save draft: payload failed server schema validation.'
        });
        return;
      }

      let savedDraft: PlatformConfigVersionItem;
      if (selectedDraftId === 'NEW') {
        const res = await adminApi.createConfigDraft({
          changeReason: changeReason.trim(),
          baseVersion: activeVersion?.version ?? null,
          payload: draftPayload,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null
        });
        savedDraft = res.draft;
      } else {
        const res = await adminApi.updateConfigDraft(selectedDraftId, {
          payload: draftPayload,
          changeReason: changeReason.trim(),
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null
        });
        savedDraft = res.draft;
      }

      setShowReviewModal(false);
      await loadConfigurationData(true);
      setSelectedDraftId(savedDraft.id);
      setActionBanner({
        type: 'success',
        message: `Configuration Draft v${savedDraft.version} saved (Checksum: ${savedDraft.checksum.slice(
          0,
          12
        )}...). Ready to submit for approval when finalized.`
      });
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save configuration draft'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndSubmitForApproval = async () => {
    if (changeReason.trim().length < 5) {
      setActionBanner({
        type: 'error',
        message: 'A detailed change reason (minimum 5 characters) is required before submitting for approval.'
      });
      return;
    }

    setIsSubmitting(true);
    setActionBanner(null);
    try {
      const valRes = await adminApi.validateConfigDraft(draftPayload, activeVersion?.version ?? null);
      setValidationResult(valRes);
      if (!valRes.valid) {
        setActionBanner({
          type: 'error',
          message: 'Cannot submit: payload failed server schema validation.'
        });
        return;
      }

      let draftId = selectedDraftId;
      if (draftId === 'NEW') {
        const created = await adminApi.createConfigDraft({
          changeReason: changeReason.trim(),
          baseVersion: activeVersion?.version ?? null,
          payload: draftPayload,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null
        });
        draftId = created.draft.id;
      } else {
        await adminApi.updateConfigDraft(draftId, {
          payload: draftPayload,
          changeReason: changeReason.trim(),
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null
        });
      }

      const submittedRes = await adminApi.submitConfigDraft(draftId);
      setShowReviewModal(false);
      await loadConfigurationData(false);
      setActionBanner({
        type: 'success',
        message: `Version v${submittedRes.version.version} submitted to the Maker-Checker Approval Queue (Status: ${submittedRes.version.status}). It is now immutable and awaits independent reviewer sign-off.`
      });
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to submit configuration draft for approval'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDiscardDraft = async () => {
    if (selectedDraftId === 'NEW') {
      setDraftPayload(structuredClone(activePayload));
      setValidationResult(null);
      setShowDiscardConfirm(false);
      return;
    }

    setIsDeleting(true);
    setActionBanner(null);
    try {
      const res = await adminApi.deleteConfigDraft(selectedDraftId);
      setShowDiscardConfirm(false);
      await loadConfigurationData(false);
      setActionBanner({
        type: 'info',
        message: `Un-submitted Draft v${res.version} was discarded.`
      });
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to discard draft'
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (permissionDenied || (!canRead && !isLoading)) {
    return (
      <Card className="p-8 border-amber-500/30 bg-[#0C1B2A]">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div className="space-y-2">
            <h2 className="text-base font-bold text-[#F5F7FA]">
              Configuration Read Permission Required (`config.read`)
            </h2>
            <p className="text-xs text-[#8FA3B7] max-w-2xl">
              Your current role assignment does not include <code className="font-mono text-[#18C986]">config.read</code>.
              You can still inspect Feature Flags (<code className="font-mono">flags.read</code>) and Maintenance Mode (<code className="font-mono">maintenance.read</code>).
            </p>
            <div className="flex items-center gap-2 pt-2">
              <Link href="/configuration/feature-flags">
                <Button variant="secondary" size="sm">Open Feature Flags</Button>
              </Link>
              <Link href="/configuration/maintenance">
                <Button variant="secondary" size="sm">Open Maintenance Mode</Button>
              </Link>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header & Active Version Telemetry Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-[#0C1B2A] border border-[#274056] rounded-xl p-5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-[#F5F7FA]">{title}</h2>
            {domains.map((dom) => {
              const meta = CONFIG_DOMAIN_METADATA[dom];
              return (
                <React.Fragment key={dom}>
                  <Badge variant="default">{dom}</Badge>
                  {meta?.isRestricted && (
                    <Badge variant="gold">
                      <ShieldAlert className="w-3 h-3" />
                      Maker-Checker Domain
                    </Badge>
                  )}
                </React.Fragment>
              );
            })}
          </div>
          <p className="text-xs text-[#8FA3B7]">{subtitle}</p>
          <p className="text-[11px] text-[#18C986]/90 font-medium pt-0.5">{impactNotice}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {activeVersion && (
            <div className="bg-[#000000] border border-[#274056] rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[#8FA3B7]">Active:</span>
                <span className="font-mono font-bold text-[#F5F7FA]">v{activeVersion.version}</span>
                <Badge variant="success" size="sm">ACTIVE</Badge>
              </div>
              <div className="font-mono text-[10px] text-[#53677A] mt-0.5" title={activeVersion.checksum}>
                SHA-256: {activeVersion.checksum?.slice(0, 16)}…
              </div>
            </div>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadConfigurationData(isDirty)}
            isLoading={isLoading}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>

          <Link href="/configuration/versions">
            <Button variant="outline" size="sm">
              <History className="w-3.5 h-3.5" />
              History
            </Button>
          </Link>

          <Link href="/configuration/approvals">
            <Button variant="outline" size="sm">
              <CheckSquare className="w-3.5 h-3.5" />
              Approvals
              {pendingApprovalsCount > 0 && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                  {pendingApprovalsCount}
                </span>
              )}
            </Button>
          </Link>
        </div>
      </div>

      {/* Role / Propose Governance Banner */}
      {!canEdit && (
        <div className="bg-[#132638] border border-[#274056] rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Lock className="w-4 h-4 text-[#18C986] shrink-0" />
            <div className="text-xs">
              <span className="font-semibold text-[#F5F7FA]">Read-Only Governance Mode: </span>
              <span className="text-[#8FA3B7]">
                Proposing changes in {domains.join(' & ')} requires{' '}
                {domains.map((d) => CONFIG_DOMAIN_METADATA[d]?.proposePermissionLabel).join(' / ')}.
                You can inspect all active values and historical diffs.
              </span>
            </div>
          </div>
          <Badge variant="default">Read Only</Badge>
        </div>
      )}

      {/* Draft Selector & Editing Controls Bar */}
      {canEdit && (
        <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#F5F7FA]">
              <FileEdit className="w-4 h-4 text-[#18C986]" />
              <span>Working Context:</span>
            </div>
            <select
              aria-label="Select configuration draft context"
              value={selectedDraftId}
              onChange={(e) => handleSelectDraft(e.target.value)}
              className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986]"
            >
              <option value="NEW">
                New Draft (cloned from Active v{activeVersion?.version ?? 1})
              </option>
              {availableDrafts.map((d) => (
                <option key={d.id} value={d.id}>
                  Resume Draft v{d.version} — {d.changeReason.slice(0, 48)} ({formatDate(d.createdAt)})
                </option>
              ))}
            </select>

            {selectedDraftId !== 'NEW' && (
              <Badge variant="info">Editing Draft ID: {selectedDraftId.slice(0, 8)}…</Badge>
            )}
            {isDirty && (
              <Badge variant="warning">
                {diffSummary.totalChanged} Unsaved Modification(s)
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(isDirty || selectedDraftId !== 'NEW') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDiscardConfirm(true)}
              >
                {selectedDraftId === 'NEW' ? (
                  <>
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Changes
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                    Discard Draft
                  </>
                )}
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={handleValidateDraft}
              isLoading={isValidating}
            >
              <Sparkles className="w-3.5 h-3.5 text-[#18C986]" />
              Validate Payload
            </Button>

            <Button
              variant="primary"
              size="sm"
              disabled={!isDirty && selectedDraftId === 'NEW'}
              onClick={() => setShowReviewModal(true)}
            >
              <Send className="w-3.5 h-3.5" />
              Review &amp; Save / Submit ({diffSummary.totalChanged})
            </Button>
          </div>
        </div>
      )}

      {/* Action / Validation Feedback Banner */}
      {actionBanner && (
        <div
          role="status"
          className={`rounded-xl p-4 border flex items-start justify-between gap-3 text-xs ${
            actionBanner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : actionBanner.type === 'error'
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {actionBanner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p className="font-medium">{actionBanner.message}</p>
              {validationResult && !validationResult.valid && validationResult.errors && (
                <ul className="list-disc list-inside text-[11px] space-y-0.5 pt-1">
                  {validationResult.errors.map((issue, i) => (
                    <li key={i}>
                      <span className="font-mono">{issue.path?.join('.') || 'payload'}</span>: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-current opacity-70 hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Load Error State */}
      {loadError ? (
        <Card className="p-8 border-rose-500/30 text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto" />
          <div className="text-sm font-bold text-[#F5F7FA]">Unable to Load Configuration</div>
          <p className="text-xs text-[#8FA3B7] max-w-md mx-auto">{loadError}</p>
          <Button variant="secondary" size="sm" onClick={() => loadConfigurationData(false)}>
            Retry
          </Button>
        </Card>
      ) : isLoading ? (
        <Card className="p-10 text-center space-y-2">
          <RefreshCw className="w-6 h-6 text-[#18C986] animate-spin mx-auto" />
          <p className="text-xs text-[#8FA3B7]">Loading authoritative configuration from PostgreSQL…</p>
        </Card>
      ) : (
        /* Domain Form Children */
        children({
          activePayload,
          draftPayload,
          updateDraftPayload,
          canEdit,
          isDirty,
          fieldErrors
        })
      )}

      {/* Review & Save / Submit Modal */}
      {showReviewModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-config-modal-title"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl">
            <div className="px-6 py-4 border-b border-[#274056] flex items-center justify-between">
              <div>
                <h3 id="review-config-modal-title" className="text-base font-bold text-[#F5F7FA]">
                  Review Configuration Changes Before Saving / Submitting
                </h3>
                <p className="text-xs text-[#8FA3B7] mt-0.5">
                  Verify modified parameters, Maker-Checker requirements, and provide an auditable change reason.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowReviewModal(false)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
                aria-label="Close review modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 flex-1">
              {diffSummary.isRestricted && (
                <div className="bg-[#0E2E2B]/40 border border-[#18C986]/40 rounded-xl p-4 flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-[#18C986] shrink-0 mt-0.5" />
                  <div className="text-xs space-y-1">
                    <div className="font-bold text-[#18C986]">
                      Maker-Checker Dual Control Required ({diffSummary.modifiedDomains.join(', ')})
                    </div>
                    <p className="text-[#F5F7FA]/90">
                      This proposal modifies restricted financial, tier, safer-play, or KYC parameters. Once submitted,
                      the version becomes strictly immutable and requires approval from an independent administrator
                      (author cannot self-approve) before a <code className="font-mono">SUPER_ADMIN</code> can activate it.
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Mandatory Change Reason (Min 5 Characters)"
                  placeholder="e.g., Adjust Master stake ceiling and turn timer for Q4 season"
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                  helperText="Recorded permanently in PlatformConfigVersion and AdminAuditLog."
                />
                <Input
                  label="Scheduled Effective Target (Optional)"
                  type="datetime-local"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  helperText="Advisory target effective timestamp for reviewers and operators."
                />
              </div>

              <ConfigDiffViewer
                basePayload={activePayload}
                targetPayload={draftPayload}
                baseLabel={`Active (v${activeVersion?.version ?? 1})`}
                targetLabel="Proposed Draft"
              />
            </div>

            <div className="px-6 py-4 border-t border-[#274056] bg-[#000000]/60 flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={() => setShowReviewModal(false)}>
                Cancel
              </Button>
              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSaveDraftOnly}
                  isLoading={isSaving}
                  disabled={isSubmitting}
                >
                  <FileEdit className="w-3.5 h-3.5" />
                  Save as Draft (Keep Editable)
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveAndSubmitForApproval}
                  isLoading={isSubmitting}
                  disabled={isSaving}
                >
                  <Send className="w-3.5 h-3.5" />
                  Save &amp; Submit for Approval (Lock Version)
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Discard / Reset Confirmation Dialog */}
      {showDiscardConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                {selectedDraftId === 'NEW' ? 'Reset Unsaved Edits?' : 'Discard Un-Submitted Draft?'}
              </h3>
            </div>
            <p className="text-xs text-[#8FA3B7]">
              {selectedDraftId === 'NEW'
                ? 'All unsaved edits in the current form will be reverted back to the currently active configuration values.'
                : 'This un-submitted DRAFT version will be permanently deleted from the database and recorded in the admin audit trail. Submitted or active versions can never be deleted.'}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowDiscardConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleDiscardDraft}
                isLoading={isDeleting}
              >
                {selectedDraftId === 'NEW' ? 'Reset to Active' : 'Delete Draft'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
