'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import {
  PlatformConfigVersionItem,
  FeatureFlagItem,
  NotificationTemplateItem,
  ChannelCapabilityItem,
  MaintenanceStateItem,
  AuditLogItem
} from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate, formatNaira } from '@/lib/utils';
import {
  RefreshCw,
  CheckCircle2,
  Flag,
  Wrench,
  GitBranch,
  CheckSquare,
  AlertTriangle,
  ArrowRight,
  Lock,
  Search
} from 'lucide-react';

export default function ConfigurationOverviewPage() {
  const { user } = useAuth();
  const canReadConfig = canAccessPermission(user, PERMISSIONS.CONFIG_READ);
  const canReadFlags = canAccessPermission(user, PERMISSIONS.FLAGS_READ);
  const canReadMaintenance = canAccessPermission(user, PERMISSIONS.MAINTENANCE_READ);
  const canReadAudit = canAccessPermission(user, PERMISSIONS.AUDIT_READ);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeConfig, setActiveConfig] = useState<PlatformConfigVersionItem | null>(null);
  const [versions, setVersions] = useState<PlatformConfigVersionItem[]>([]);
  const [flags, setFlags] = useState<FeatureFlagItem[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplateItem[]>([]);
  const [channels, setChannels] = useState<ChannelCapabilityItem[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceStateItem | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const fetchOverviewData = useCallback(async () => {
    setError(null);
    try {
      const promises: Promise<void>[] = [];

      if (canReadConfig) {
        promises.push(
          adminApi.getActiveConfig().then((res) => setActiveConfig(res.config)).catch(() => {}),
          adminApi
            .getConfigVersions({ page: 1, limit: 30 })
            .then((res) => setVersions(res.versions || []))
            .catch(() => {}),
          adminApi
            .getNotificationTemplates()
            .then((res) => {
              setTemplates(res.templates || []);
              setChannels(res.channelCapabilities || []);
            })
            .catch(() => {})
        );
      }

      if (canReadFlags) {
        promises.push(
          adminApi
            .getFeatureFlags()
            .then((res) => setFlags(res.flags || []))
            .catch(() => {})
        );
      }

      if (canReadMaintenance) {
        promises.push(
          adminApi
            .getMaintenanceState()
            .then((res) => setMaintenance(res.maintenance))
            .catch(() => {})
        );
      }

      if (canReadAudit) {
        promises.push(
          adminApi
            .getAuditLogs({ page: 1, limit: 25, search: 'config' })
            .then((res) => setAuditLogs(res.logs || []))
            .catch(() => {})
        );
      }

      await Promise.all(promises);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration overview');
    } finally {
      setIsLoading(false);
    }
  }, [canReadConfig, canReadFlags, canReadMaintenance, canReadAudit]);

  useEffect(() => {
    (async () => {
      await fetchOverviewData();
    })();
  }, [fetchOverviewData]);

  const pendingDrafts = useMemo(
    () => versions.filter((v) => v.status === 'DRAFT'),
    [versions]
  );

  const pendingApprovals = useMemo(
    () => versions.filter((v) => v.status === 'PENDING_APPROVAL'),
    [versions]
  );

  const approvedReadyToActivate = useMemo(
    () => versions.filter((v) => v.status === 'APPROVED'),
    [versions]
  );

  const scheduledVersions = useMemo(
    () =>
      versions.filter(
        (v) =>
          v.effectiveFrom &&
          (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' || v.status === 'APPROVED')
      ),
    [versions]
  );

  const recentApprovalDecisions = useMemo(() => {
    const list: Array<{
      version: number;
      versionId: string;
      status: string;
      reviewerEmail: string;
      reviewNote: string | null;
      reviewedAt: string | null;
      checksum: string;
    }> = [];

    for (const v of versions) {
      if (Array.isArray(v.approvals)) {
        for (const a of v.approvals) {
          list.push({
            version: v.version,
            versionId: v.id,
            status: a.status,
            reviewerEmail: a.reviewer?.email || a.reviewerId,
            reviewNote: a.reviewNote,
            reviewedAt: a.reviewedAt || a.createdAt,
            checksum: a.checksum
          });
        }
      }
    }
    return list.slice(0, 8);
  }, [versions]);

  const validationOrDeniedLogs = useMemo(
    () => auditLogs.filter((l) => l.outcome === 'FAILURE' || l.outcome === 'DENIED'),
    [auditLogs]
  );

  const filteredVersions = useMemo(() => {
    return versions.filter((v) => {
      if (statusFilter !== 'ALL' && v.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchReason = v.changeReason?.toLowerCase().includes(q);
        const matchChecksum = v.checksum?.toLowerCase().includes(q);
        const matchAuthor = v.author?.email?.toLowerCase().includes(q);
        const matchVersion = `v${v.version}`.includes(q) || String(v.version) === q;
        const matchDomain = v.modifiedDomains?.some((d) => d.toLowerCase().includes(q));
        return matchReason || matchChecksum || matchAuthor || matchVersion || matchDomain;
      }
      return true;
    });
  }, [versions, statusFilter, searchQuery]);

  const enabledFlagsCount = useMemo(() => flags.filter((f) => f.enabled).length, [flags]);
  const killSwitchCount = useMemo(() => flags.filter((f) => f.isKillSwitch).length, [flags]);
  const trippedKillSwitches = useMemo(
    () => flags.filter((f) => f.isKillSwitch && !f.enabled),
    [flags]
  );

  const activeTemplatesCount = useMemo(
    () => templates.filter((t) => t.isActive).length,
    [templates]
  );

  const getVersionBadge = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return <Badge variant="success">ACTIVE</Badge>;
      case 'APPROVED':
        return <Badge variant="info">APPROVED (READY)</Badge>;
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

  return (
    <div className="space-y-6">
      {/* Top Action & Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#15181D] border border-[#2E333B] rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-bold uppercase tracking-wider text-[#9CA3AF]">
            Global Governance Status:
          </span>
          {activeConfig ? (
            <>
              <Badge variant="gold">Active Config v{activeConfig.version}</Badge>
              <span className="font-mono text-[#9CA3AF]">
                SHA-256: {activeConfig.checksum.slice(0, 16)}…
              </span>
            </>
          ) : !canReadConfig ? (
            <Badge variant="warning">Config Read Restricted (Role Scoped)</Badge>
          ) : (
            <Badge variant="default">Loading Baseline…</Badge>
          )}

          {maintenance && (
            <Badge variant={maintenance.effectivelyActive ? 'danger' : 'success'}>
              Maintenance: {maintenance.effectiveStatus} ({maintenance.scope})
            </Badge>
          )}

          {trippedKillSwitches.length > 0 && (
            <Badge variant="danger">
              {trippedKillSwitches.length} Kill Switch(es) Tripped
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setIsLoading(true);
              void fetchOverviewData();
            }}
            isLoading={isLoading}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Overview
          </Button>
          {canReadConfig && (
            <Link href="/configuration/approvals">
              <Button variant="primary" size="sm">
                <CheckSquare className="w-3.5 h-3.5" />
                Approvals Queue ({pendingApprovals.length})
              </Button>
            </Link>
          )}
        </div>
      </div>

      {error && (
        <Card className="p-5 border-rose-500/30 bg-rose-500/5 text-xs text-rose-300 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={fetchOverviewData}>
            Retry
          </Button>
        </Card>
      )}

      {/* 4 Primary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Card 1: Active Configuration Version */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
              Active Configuration
            </span>
            <GitBranch className="w-4 h-4 text-[#E7B24A]" />
          </div>
          {canReadConfig ? (
            activeConfig ? (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold font-mono text-[#F4F2ED]">
                    v{activeConfig.version}
                  </span>
                  {getVersionBadge(activeConfig.status)}
                </div>
                <div className="space-y-1 text-[11px] text-[#9CA3AF] pt-1 border-t border-[#2E333B]">
                  <div className="flex justify-between">
                    <span>Activated:</span>
                    <span className="font-mono text-[#F4F2ED]">
                      {formatDate(activeConfig.activatedAt || activeConfig.createdAt)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Modified:</span>
                    <span className="font-mono text-[#F4F2ED]">
                      {formatDate(activeConfig.updatedAt || activeConfig.createdAt)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Checksum:</span>
                    <span className="font-mono text-[#E7B24A]" title={activeConfig.checksum}>
                      {activeConfig.checksum.slice(0, 14)}…
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-[#6B7280] py-4">No active configuration loaded.</p>
            )
          ) : (
            <div className="flex items-center gap-2 text-xs text-[#9CA3AF] py-4">
              <Lock className="w-4 h-4 text-amber-400" />
              <span>Requires `config.read`</span>
            </div>
          )}
        </Card>

        {/* Card 2: Drafts, Approvals & Scheduled Pipeline */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
              Maker-Checker Pipeline
            </span>
            <CheckSquare className="w-4 h-4 text-amber-400" />
          </div>
          {canReadConfig ? (
            <>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-2.5 text-center">
                  <div className="text-lg font-bold font-mono text-[#F4F2ED]">
                    {pendingDrafts.length}
                  </div>
                  <div className="text-[10px] uppercase text-[#9CA3AF]">Drafts</div>
                </div>
                <div className="bg-[#0B0D10] border border-amber-500/30 rounded-lg p-2.5 text-center">
                  <div className="text-lg font-bold font-mono text-amber-400">
                    {pendingApprovals.length}
                  </div>
                  <div className="text-[10px] uppercase text-amber-400">Awaiting</div>
                </div>
                <div className="bg-[#0B0D10] border border-sky-500/30 rounded-lg p-2.5 text-center">
                  <div className="text-lg font-bold font-mono text-sky-400">
                    {approvedReadyToActivate.length}
                  </div>
                  <div className="text-[10px] uppercase text-sky-400">Approved</div>
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] text-[#9CA3AF] pt-1 border-t border-[#2E333B]">
                <span>Scheduled Target Window:</span>
                <span className="font-mono text-[#F4F2ED]">{scheduledVersions.length} version(s)</span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-[#9CA3AF]">
                <span>Validation / Denied Events:</span>
                <span className="font-mono text-[#F4F2ED]">{validationOrDeniedLogs.length}</span>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[#9CA3AF] py-4">
              <Lock className="w-4 h-4 text-amber-400" />
              <span>Requires `config.read`</span>
            </div>
          )}
        </Card>

        {/* Card 3: Feature Flags & Kill Switches Summary */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
              Feature Flags &amp; Kill Switches
            </span>
            <Flag className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono text-[#F4F2ED]">
              {enabledFlagsCount} / {flags.length}
            </span>
            <Badge variant={trippedKillSwitches.length > 0 ? 'danger' : 'success'}>
              {trippedKillSwitches.length > 0
                ? `${trippedKillSwitches.length} Kill Switch Tripped`
                : 'Operational'}
            </Badge>
          </div>
          <div className="space-y-1 text-[11px] text-[#9CA3AF] pt-1 border-t border-[#2E333B]">
            <div className="flex justify-between">
              <span>Designated Kill Switches:</span>
              <span className="font-mono text-[#F4F2ED]">{killSwitchCount}</span>
            </div>
            <div className="flex justify-between">
              <span>Protected Invariants:</span>
              <span className="font-mono text-[#E7B24A]">
                {flags.filter((f) => f.isProtectedInvariant).length}
              </span>
            </div>
            <div className="pt-1">
              <Link
                href="/configuration/feature-flags"
                className="inline-flex items-center gap-1 text-[#E7B24A] hover:underline font-medium"
              >
                Manage Feature Flags <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </Card>

        {/* Card 4: Maintenance & Notification Templates Summary */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
              Maintenance &amp; Templates
            </span>
            <Wrench className="w-4 h-4 text-sky-400" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-bold text-[#F4F2ED]">
              {maintenance?.effectiveStatus || 'INACTIVE'}
            </span>
            <Badge variant={maintenance?.effectivelyActive ? 'danger' : 'success'}>
              {maintenance?.effectivelyActive ? maintenance.scope : 'Normal Traffic'}
            </Badge>
          </div>
          <div className="space-y-1 text-[11px] text-[#9CA3AF] pt-1 border-t border-[#2E333B]">
            <div className="flex justify-between">
              <span>Active Notification Templates:</span>
              <span className="font-mono text-[#F4F2ED]">
                {canReadConfig ? `${activeTemplatesCount} / ${templates.length}` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Live Delivery Channels:</span>
              <span className="font-mono text-emerald-400">
                {channels.filter((c) => c.implemented).map((c) => c.channel).join(', ') || 'IN_APP'}
              </span>
            </div>
            <div className="pt-1 flex items-center justify-between">
              <Link
                href="/configuration/maintenance"
                className="inline-flex items-center gap-1 text-[#E7B24A] hover:underline font-medium"
              >
                Maintenance <ArrowRight className="w-3 h-3" />
              </Link>
              {canReadConfig && (
                <Link
                  href="/configuration/notifications"
                  className="inline-flex items-center gap-1 text-[#E7B24A] hover:underline font-medium"
                >
                  Templates <ArrowRight className="w-3 h-3" />
                </Link>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Active Configuration Domain Snapshot Grid */}
      {canReadConfig && activeConfig?.payload && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Active Configuration Domain Snapshot (v{activeConfig.version})</CardTitle>
              <CardDescription>
                Authoritative runtime parameters currently governing new matches, financial limits, and compliance checks.
              </CardDescription>
            </div>
            <Badge variant="gold">SHA-256 Verified</Badge>
          </CardHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Domain 1: Platform */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">Platform Settings</span>
                <Badge variant="default">PLATFORM</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Identity:</span>
                  <span className="text-[#F4F2ED] font-medium">{activeConfig.payload.platform.identity}</span>
                </div>
                <div className="flex justify-between">
                  <span>Default Currency:</span>
                  <span className="font-mono text-[#E7B24A]">{activeConfig.payload.platform.defaultCurrency}</span>
                </div>
                <div className="flex justify-between">
                  <span>Support Email:</span>
                  <span className="font-mono text-[#F4F2ED]">{activeConfig.payload.platform.supportEmail}</span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/platform">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open Platform Settings
                  </Button>
                </Link>
              </div>
            </div>

            {/* Domain 2: Financial & Tiers */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">Financial &amp; Tier Stakes</span>
                <Badge variant="gold">RESTRICTED</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Commission Rake:</span>
                  <span className="font-mono text-[#E7B24A] font-bold">
                    {activeConfig.payload.financial.commissionPercent}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Deposit Bounds:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {formatNaira(activeConfig.payload.financial.minDepositMinorUnits)} –{' '}
                    {formatNaira(activeConfig.payload.financial.maxDepositMinorUnits)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Withdrawal Bounds:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {formatNaira(activeConfig.payload.financial.minWithdrawalMinorUnits)} –{' '}
                    {formatNaira(activeConfig.payload.financial.maxWithdrawalMinorUnits)}
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/financial">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open Financial Configuration
                  </Button>
                </Link>
              </div>
            </div>

            {/* Domain 3: Game Configuration */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">Game Engine &amp; Clocks</span>
                <Badge variant="default">GAME</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Ruleset Version:</span>
                  <span className="font-mono text-[#F4F2ED]">v{activeConfig.payload.game.rulesetVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span>Turn Clock / Grace:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.game.timeControlSeconds}s /{' '}
                    {activeConfig.payload.game.disconnectGraceMs / 1000}s
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>King Moves / Draw Ply:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.game.maxConsecutiveKingMoves} /{' '}
                    {activeConfig.payload.game.canOfferDrawPlyCount}
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/game">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open Game Configuration
                  </Button>
                </Link>
              </div>
            </div>

            {/* Domain 4: KYC & Eligibility */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">KYC &amp; Eligibility</span>
                <Badge variant="gold">RESTRICTED</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Mandatory KYC Threshold:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {formatNaira(activeConfig.payload.kyc.mandatoryWithdrawalThresholdMinorUnits)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Call-Out KYC Gate:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.kyc.requireVerificationForCallouts ? 'Required' : 'Optional'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Allowed Countries:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.kyc.allowedCountries.join(', ')}
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/kyc">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open KYC &amp; Eligibility
                  </Button>
                </Link>
              </div>
            </div>

            {/* Domain 5: Safer Play */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">Safer-Play Policy</span>
                <Badge variant="gold">RESTRICTED</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Limit Raise Cooling-Off:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.saferPlay.limitRaiseCoolingHours} hours
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Min Timeout Break:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.saferPlay.minTimeoutDurationMinutes} mins
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Min Self-Exclusion:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.saferPlay.minSelfExclusionDays} days
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/safer-play">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open Safer-Play Policy
                  </Button>
                </Link>
              </div>
            </div>

            {/* Domain 6: Matchmaking */}
            <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#F4F2ED]">Matchmaking Queue</span>
                <Badge variant="default">MATCHMAKING</Badge>
              </div>
              <div className="text-xs space-y-1 text-[#9CA3AF]">
                <div className="flex justify-between">
                  <span>Queue Timeout:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.matchmaking.queueTimeoutSeconds}s
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Worker Sweep Interval:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.matchmaking.cronTickSeconds}s
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Max Queue Per Player:</span>
                  <span className="font-mono text-[#F4F2ED]">
                    {activeConfig.payload.matchmaking.maxConcurrentQueuePerPlayer}
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <Link href="/configuration/matchmaking">
                  <Button variant="secondary" size="sm" className="w-full">
                    Open Matchmaking Settings
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Recent Configuration Changes & Maker-Checker Decisions */}
      {canReadConfig && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 Columns: Filterable Recent Configuration Versions */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <CardTitle>Recent Configuration Changes &amp; Proposals</CardTitle>
                <CardDescription>
                  Search and filter version proposals, drafts, approvals, and historical activations.
                </CardDescription>
              </div>
              <Link href="/configuration/versions">
                <Button variant="outline" size="sm">
                  View Full History &amp; Compare
                </Button>
              </Link>
            </CardHeader>

            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-[#6B7280] absolute left-3 top-3" />
                <input
                  type="text"
                  placeholder="Search by version, reason, author, domain, or checksum…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-9 pl-9 pr-3 bg-[#0B0D10] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-[#E7B24A]"
                />
              </div>
              <select
                aria-label="Filter configuration versions by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-9 px-3 bg-[#0B0D10] border border-[#2E333B] rounded-lg text-xs text-[#F4F2ED] focus:outline-none focus:border-[#E7B24A]"
              >
                <option value="ALL">All Statuses</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
                <option value="APPROVED">APPROVED</option>
                <option value="DRAFT">DRAFT</option>
                <option value="REJECTED">REJECTED</option>
                <option value="SUPERSEDED">SUPERSEDED</option>
              </select>
            </div>

            {filteredVersions.length === 0 ? (
              <div className="py-10 text-center text-xs text-[#6B7280]">
                No configuration versions match your current filter criteria.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#2E333B] text-[10px] font-bold uppercase tracking-wider text-[#6B7280]">
                      <th className="py-2.5 px-3">Ver</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Reason &amp; Domains</th>
                      <th className="py-2.5 px-3">Author</th>
                      <th className="py-2.5 px-3">Created</th>
                      <th className="py-2.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2E333B] text-xs">
                    {filteredVersions.slice(0, 8).map((v) => (
                      <tr key={v.id} className="hover:bg-[#1E2229]/60">
                        <td className="py-3 px-3 font-mono font-bold text-[#F4F2ED]">
                          v{v.version}
                          {v.rolledBackFrom && (
                            <span className="block text-[10px] text-amber-400">
                              ↶ from v{v.rolledBackFrom}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3">{getVersionBadge(v.status)}</td>
                        <td className="py-3 px-3">
                          <div className="font-medium text-[#F4F2ED] line-clamp-1">{v.changeReason}</div>
                          <div className="flex flex-wrap items-center gap-1 mt-1">
                            {v.modifiedDomains?.length > 0 ? (
                              v.modifiedDomains.map((d) => (
                                <span
                                  key={d}
                                  className="px-1.5 py-0.5 rounded bg-[#0B0D10] border border-[#2E333B] text-[10px] font-mono text-[#9CA3AF]"
                                >
                                  {d}
                                </span>
                              ))
                            ) : (
                              <span className="text-[10px] text-[#6B7280]">Baseline / No domain diff</span>
                            )}
                            {v.isRestricted && (
                              <span className="text-[10px] text-[#E7B24A] font-semibold ml-1">
                                • Maker-Checker
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-[#9CA3AF]">
                          {v.author?.email || v.authorId.slice(0, 8)}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-[#9CA3AF]">
                          {formatDate(v.createdAt)}
                        </td>
                        <td className="py-3 px-3 text-right">
                          {v.status === 'PENDING_APPROVAL' || v.status === 'APPROVED' ? (
                            <Link href={`/configuration/approvals?version=${v.version}`}>
                              <Button variant="secondary" size="sm">Review</Button>
                            </Link>
                          ) : (
                            <Link href={`/configuration/versions?inspect=${v.version}`}>
                              <Button variant="ghost" size="sm">Inspect</Button>
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Right Column: Recent Approval Decisions & Validation Alerts */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Recent Approval Decisions</CardTitle>
                  <CardDescription>Checksum-bound Maker-Checker reviews.</CardDescription>
                </div>
              </CardHeader>

              {recentApprovalDecisions.length === 0 ? (
                <p className="text-xs text-[#6B7280] py-6 text-center">
                  No Maker-Checker approval decisions recorded yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {recentApprovalDecisions.map((dec, idx) => (
                    <div
                      key={`${dec.versionId}-${idx}`}
                      className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-[#F4F2ED]">
                          Version v{dec.version}
                        </span>
                        <Badge variant={dec.status === 'APPROVED' ? 'success' : 'danger'}>
                          {dec.status}
                        </Badge>
                      </div>
                      <div className="text-[#9CA3AF]">
                        Reviewer: <span className="text-[#F4F2ED]">{dec.reviewerEmail}</span>
                      </div>
                      {dec.reviewNote && (
                        <div className="text-[11px] text-[#9CA3AF] italic">
                          &ldquo;{dec.reviewNote}&rdquo;
                        </div>
                      )}
                      <div className="flex items-center justify-between text-[10px] font-mono text-[#6B7280] pt-1">
                        <span>SHA: {dec.checksum?.slice(0, 10)}…</span>
                        <span>{formatDate(dec.reviewedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Governance &amp; Validation Alerts</CardTitle>
                  <CardDescription>Recent denied or failed configuration attempts.</CardDescription>
                </div>
              </CardHeader>

              {validationOrDeniedLogs.length === 0 ? (
                <div className="py-6 text-center space-y-1">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto opacity-80" />
                  <p className="text-xs text-[#9CA3AF]">Zero validation or permission violations logged.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {validationOrDeniedLogs.slice(0, 5).map((log) => (
                    <div
                      key={log.id}
                      className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-rose-300">{log.action}</span>
                        <Badge variant="danger">{log.outcome}</Badge>
                      </div>
                      <div className="text-[11px] text-[#9CA3AF]">
                        Actor: {log.actor?.email || log.adminId.slice(0, 8)} • {formatDate(log.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
