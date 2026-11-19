'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { ADMIN_ROLES, AdminRole } from '@/lib/permissions/roles';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import {
  FeatureFlagItem,
  FeatureFlagEvaluation,
  AuditLogItem,
  PlayerTier
} from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  Flag,
  Search,
  Plus,
  RefreshCw,
  ShieldAlert,
  Lock,
  Zap,
  History,
  SlidersHorizontal,
  Play,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  X
} from 'lucide-react';

const ALL_TIERS: PlayerTier[] = ['AMATEUR', 'MASTER', 'PRO'];

export default function FeatureFlagsPage() {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.FLAGS_READ);
  const canManage = canAccessPermission(user, PERMISSIONS.FLAGS_MANAGE);
  const canKillSwitch =
    canAccessPermission(user, PERMISSIONS.FLAGS_KILLSWITCH) || canManage;

  const [flags, setFlags] = useState<FeatureFlagItem[]>([]);
  const [isLoading, setIsLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ENABLED' | 'DISABLED'>('ALL');
  const [rolloutFilter, setRolloutFilter] = useState<'ALL' | 'FULL' | 'PARTIAL' | 'ZERO'>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'KILL_SWITCH' | 'PROTECTED'>('ALL');

  // Create / Edit Modal state
  const [editorMode, setEditorMode] = useState<'CREATE' | 'EDIT' | null>(null);
  const [editingFlag, setEditingFlag] = useState<FeatureFlagItem | null>(null);
  const [formKey, setFormKey] = useState('');
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formEnabled, setFormEnabled] = useState(false);
  const [formRollout, setFormRollout] = useState(100);
  const [formTiers, setFormTiers] = useState<PlayerTier[]>([]);
  const [formRoles, setFormRoles] = useState<AdminRole[]>(['SUPER_ADMIN']);
  const [formIsKillSwitch, setFormIsKillSwitch] = useState(false);
  const [formReason, setFormReason] = useState('');
  const [isSubmittingForm, setIsSubmittingForm] = useState(false);

  // Toggle / Kill-Switch / Delete Dialog state
  const [actionModal, setActionModal] = useState<{
    mode: 'TOGGLE' | 'KILL_SWITCH' | 'DELETE';
    flag: FeatureFlagItem;
    targetEnabled: boolean;
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [isExecutingAction, setIsExecutingAction] = useState(false);

  // History & Evaluator Drawer state
  const [historyFlag, setHistoryFlag] = useState<FeatureFlagItem | null>(null);
  const [historyLogs, setHistoryLogs] = useState<AuditLogItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [evalFlagKey, setEvalFlagKey] = useState<string>('');
  const [evalUserId, setEvalUserId] = useState('player-test-001');
  const [evalUserTier, setEvalUserTier] = useState<PlayerTier>('MASTER');
  const [evalResult, setEvalResult] = useState<FeatureFlagEvaluation | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);

  const loadFlags = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.getFeatureFlags();
      const loaded = res.flags || [];
      setFlags(loaded);
      setEvalFlagKey((prev) => prev || (loaded[0]?.key ?? ''));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load feature flags');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    (async () => {
      await loadFlags();
    })();
  }, [canRead, loadFlags]);

  const filteredFlags = useMemo(() => {
    return flags.filter((f) => {
      if (statusFilter === 'ENABLED' && !f.enabled) return false;
      if (statusFilter === 'DISABLED' && f.enabled) return false;

      if (rolloutFilter === 'FULL' && f.rolloutPercentage !== 100) return false;
      if (rolloutFilter === 'PARTIAL' && (f.rolloutPercentage <= 0 || f.rolloutPercentage >= 100)) return false;
      if (rolloutFilter === 'ZERO' && f.rolloutPercentage !== 0) return false;

      if (typeFilter === 'KILL_SWITCH' && !f.isKillSwitch) return false;
      if (typeFilter === 'PROTECTED' && !f.isProtectedInvariant) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchKey = f.key.toLowerCase().includes(q);
        const matchName = f.name.toLowerCase().includes(q);
        const matchDesc = f.description?.toLowerCase().includes(q);
        return matchKey || matchName || matchDesc;
      }

      return true;
    });
  }, [flags, statusFilter, rolloutFilter, typeFilter, searchQuery]);

  const openCreateModal = () => {
    setEditorMode('CREATE');
    setEditingFlag(null);
    setFormKey('');
    setFormName('');
    setFormDescription('');
    setFormEnabled(false);
    setFormRollout(100);
    setFormTiers([]);
    setFormRoles(['SUPER_ADMIN']);
    setFormIsKillSwitch(false);
    setFormReason('');
  };

  const openEditModal = (flag: FeatureFlagItem) => {
    setEditorMode('EDIT');
    setEditingFlag(flag);
    setFormKey(flag.key);
    setFormName(flag.name);
    setFormDescription(flag.description || '');
    setFormEnabled(flag.enabled);
    setFormRollout(flag.rolloutPercentage);
    setFormTiers(flag.allowedTiers || []);
    setFormRoles(flag.allowedRoles || []);
    setFormIsKillSwitch(flag.isKillSwitch);
    setFormReason('');
  };

  const handleSaveFlagForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A change reason of at least 5 characters is required.'
      });
      return;
    }

    setIsSubmittingForm(true);
    setBanner(null);
    try {
      if (editorMode === 'CREATE') {
        const res = await adminApi.createFeatureFlag({
          key: formKey.trim().toLowerCase(),
          name: formName.trim(),
          description: formDescription.trim() || null,
          enabled: formEnabled,
          rolloutPercentage: formRollout,
          allowedTiers: formTiers,
          allowedRoles: formRoles,
          isKillSwitch: formIsKillSwitch,
          changeReason: formReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Feature flag '${res.flag.key}' created and audited.`
        });
      } else if (editorMode === 'EDIT' && editingFlag) {
        const res = await adminApi.updateFeatureFlag(editingFlag.key, {
          name: formName.trim(),
          description: formDescription.trim() || null,
          enabled: formEnabled,
          rolloutPercentage: formRollout,
          allowedTiers: formTiers,
          allowedRoles: formRoles,
          isKillSwitch: formIsKillSwitch,
          changeReason: formReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Feature flag '${res.flag.key}' updated (${res.flag.rolloutPercentage}% rollout).`
        });
      }
      setEditorMode(null);
      await loadFlags();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save feature flag'
      });
    } finally {
      setIsSubmittingForm(false);
    }
  };

  const handleExecuteActionModal = async () => {
    if (!actionModal) return;
    if (actionReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'An operational reason of at least 5 characters is mandatory.'
      });
      return;
    }

    setIsExecutingAction(true);
    setBanner(null);
    try {
      const { mode, flag, targetEnabled } = actionModal;
      if (mode === 'TOGGLE') {
        await adminApi.toggleFeatureFlag(flag.key, {
          enabled: targetEnabled,
          changeReason: actionReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Feature flag '${flag.key}' ${targetEnabled ? 'enabled' : 'disabled'}.`
        });
      } else if (mode === 'KILL_SWITCH') {
        await adminApi.triggerFeatureFlagKillSwitch(flag.key, {
          enabled: targetEnabled,
          reason: actionReason.trim()
        });
        setBanner({
          type: 'success',
          message: `Operational kill switch '${flag.key}' ${
            targetEnabled ? 'restored to normal operation' : 'TRIPPED (disabled)'
          }.`
        });
      } else if (mode === 'DELETE') {
        await adminApi.deleteFeatureFlag(flag.key, actionReason.trim());
        setBanner({
          type: 'info',
          message: `Feature flag '${flag.key}' deleted.`
        });
      }
      setActionModal(null);
      setActionReason('');
      await loadFlags();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Operation failed'
      });
    } finally {
      setIsExecutingAction(false);
    }
  };

  const handleOpenHistory = async (flag: FeatureFlagItem) => {
    setHistoryFlag(flag);
    setIsLoadingHistory(true);
    try {
      const res = await adminApi.getFeatureFlagHistory(flag.key, { page: 1, limit: 25 });
      setHistoryLogs(res.history || []);
    } catch {
      setHistoryLogs([]);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleRunEvaluator = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!evalFlagKey) return;
    setIsEvaluating(true);
    try {
      const res = await adminApi.evaluateFeatureFlag(evalFlagKey, {
        userId: evalUserId.trim() || null,
        userTier: evalUserTier
      });
      setEvalResult(res.evaluation);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to evaluate feature flag'
      });
    } finally {
      setIsEvaluating(false);
    }
  };

  const toggleTierSelection = (tier: PlayerTier) => {
    setFormTiers((prev) =>
      prev.includes(tier) ? prev.filter((t) => t !== tier) : [...prev, tier]
    );
  };

  const toggleRoleSelection = (role: AdminRole) => {
    setFormRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  return (
    <div className="space-y-6">
      {/* Security Boundary Notice */}
      <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-[#18C986] shrink-0 mt-0.5" />
          <div className="text-xs space-y-0.5">
            <div className="font-bold text-[#F5F7FA]">
              Authoritative RBAC Boundary &amp; Protected Invariant Enforcement
            </div>
            <p className="text-[#8FA3B7]">
              Feature flags control progressive rollout, tier targeting, operational kill-switches, and admin UI
              visibility only. They <strong>never grant administrative permissions</strong> or bypass backend RBAC,
              KYC, safer-play, or ledger invariants. Flags marked <code className="font-mono text-[#18C986]">Protected Invariant</code>{' '}
              are locked at 100% enabled.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setIsLoading(true);
              void loadFlags();
            }}
            isLoading={isLoading}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
          {canManage && (
            <Button variant="primary" size="sm" onClick={openCreateModal}>
              <Plus className="w-3.5 h-3.5" />
              Create Feature Flag
            </Button>
          )}
        </div>
      </div>

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

      {/* Search & Filter Bar */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-[#53677A] absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search by key, name, or description…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] placeholder-[#53677A] focus:outline-none focus:border-[#18C986]"
            />
          </div>

          <select
            aria-label="Filter feature flags by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ENABLED' | 'DISABLED')}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All Statuses</option>
            <option value="ENABLED">Enabled Only</option>
            <option value="DISABLED">Disabled / Tripped Only</option>
          </select>

          <select
            aria-label="Filter feature flags by rollout percentage"
            value={rolloutFilter}
            onChange={(e) => setRolloutFilter(e.target.value as 'ALL' | 'FULL' | 'PARTIAL' | 'ZERO')}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All Rollout Percentages</option>
            <option value="FULL">100% Full Rollout</option>
            <option value="PARTIAL">Partial Rollout (1% – 99%)</option>
            <option value="ZERO">0% Rollout</option>
          </select>

          <select
            aria-label="Filter feature flags by classification"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'ALL' | 'KILL_SWITCH' | 'PROTECTED')}
            className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA]"
          >
            <option value="ALL">All Flag Classifications</option>
            <option value="KILL_SWITCH">Operational Kill Switches Only</option>
            <option value="PROTECTED">Protected Invariants Only</option>
          </select>
        </div>
      </Card>

      {/* Feature Flags Directory Table */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Feature Flags &amp; Kill Switches ({filteredFlags.length})</CardTitle>
            <CardDescription>
              Deterministic SHA-256 percentage rollout, player tier targeting, and operational circuit breakers.
            </CardDescription>
          </div>
        </CardHeader>

        {error ? (
          <div className="py-8 text-center text-xs text-rose-400">{error}</div>
        ) : isLoading ? (
          <div className="py-10 text-center text-xs text-[#8FA3B7]">Loading feature flags…</div>
        ) : filteredFlags.length === 0 ? (
          <div className="py-10 text-center text-xs text-[#53677A]">
            No feature flags match your filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                  <th className="py-3 px-4">Flag Key &amp; Description</th>
                  <th className="py-3 px-4">State</th>
                  <th className="py-3 px-4">Rollout %</th>
                  <th className="py-3 px-4">Target Tiers</th>
                  <th className="py-3 px-4">Admin Visibility Metadata</th>
                  <th className="py-3 px-4">Last Updated</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056] text-xs">
                {filteredFlags.map((flag) => (
                  <tr key={flag.id || flag.key} className="hover:bg-[#132638]/60">
                    <td className="py-3.5 px-4 align-top max-w-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-bold text-[#F5F7FA]">{flag.key}</span>
                        {flag.isKillSwitch && (
                          <Badge variant="warning">
                            <Zap className="w-3 h-3" />
                            Kill Switch
                          </Badge>
                        )}
                        {flag.isProtectedInvariant && (
                          <Badge variant="gold">
                            <Lock className="w-3 h-3" />
                            Protected Invariant
                          </Badge>
                        )}
                      </div>
                      <div className="text-[#F5F7FA]/90 font-medium mt-0.5">{flag.name}</div>
                      {flag.description && (
                        <div className="text-[11px] text-[#8FA3B7] mt-0.5">{flag.description}</div>
                      )}
                      {flag.isProtectedInvariant && (
                        <div className="text-[10px] text-[#18C986] mt-1">
                          Locked: Core compliance/financial invariant cannot be disabled or diluted.
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      {flag.enabled ? (
                        <Badge variant="success">ENABLED</Badge>
                      ) : flag.isKillSwitch ? (
                        <Badge variant="danger">KILL SWITCH TRIPPED</Badge>
                      ) : (
                        <Badge variant="default">DISABLED</Badge>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      <div className="font-mono font-bold text-[#F5F7FA]">
                        {flag.rolloutPercentage}%
                      </div>
                      <div className="w-20 h-1.5 bg-[#000000] rounded-full overflow-hidden mt-1 border border-[#274056]">
                        <div
                          className="h-full bg-[#18C986]"
                          style={{ width: `${Math.min(100, Math.max(0, flag.rolloutPercentage))}%` }}
                        />
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      {flag.allowedTiers?.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {flag.allowedTiers.map((t) => (
                            <span
                              key={t}
                              className="px-1.5 py-0.5 rounded bg-[#000000] border border-[#274056] font-mono text-[10px] text-[#F5F7FA]"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[#8FA3B7] text-[11px]">All Tiers</span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      <div className="flex flex-wrap gap-1">
                        {flag.allowedRoles?.length > 0 ? (
                          flag.allowedRoles.map((r) => (
                            <span
                              key={r}
                              className="px-1.5 py-0.5 rounded bg-[#000000] border border-[#274056] font-mono text-[10px] text-[#8FA3B7]"
                            >
                              {r}
                            </span>
                          ))
                        ) : (
                          <span className="text-[#8FA3B7] text-[11px]">All Admin Roles</span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#53677A] mt-1">
                        UI visibility only • RBAC authoritative
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top text-[11px] text-[#8FA3B7]">
                      <div className="font-mono">{formatDate(flag.updatedAt)}</div>
                      {flag.updatedBy?.email && (
                        <div className="text-[#53677A]">by {flag.updatedBy.email}</div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenHistory(flag)}
                          title="Inspect audit history"
                        >
                          <History className="w-3.5 h-3.5" />
                          History
                        </Button>

                        {flag.isKillSwitch && canKillSwitch && !flag.isProtectedInvariant && (
                          <Button
                            variant={flag.enabled ? 'danger' : 'secondary'}
                            size="sm"
                            onClick={() => {
                              setActionReason('');
                              setActionModal({
                                mode: 'KILL_SWITCH',
                                flag,
                                targetEnabled: !flag.enabled
                              });
                            }}
                          >
                            <Zap className="w-3.5 h-3.5" />
                            {flag.enabled ? 'Trip Kill Switch' : 'Restore Switch'}
                          </Button>
                        )}

                        {canManage && !flag.isProtectedInvariant && (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setActionReason('');
                                setActionModal({
                                  mode: 'TOGGLE',
                                  flag,
                                  targetEnabled: !flag.enabled
                                });
                              }}
                            >
                              {flag.enabled ? 'Disable' : 'Enable'}
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEditModal(flag)}
                            >
                              <SlidersHorizontal className="w-3.5 h-3.5" />
                              Edit
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setActionReason('');
                                setActionModal({
                                  mode: 'DELETE',
                                  flag,
                                  targetEnabled: false
                                });
                              }}
                              aria-label={`Delete ${flag.key}`}
                            >
                              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Deterministic Rollout & Tier Targeting Simulator */}
      <Card className="space-y-4">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <Flag className="w-5 h-5 text-[#18C986]" />
            <div>
              <CardTitle>Deterministic SHA-256 Rollout &amp; Tier Evaluator (`POST /:key/evaluate`)</CardTitle>
              <CardDescription>
                Verify how the backend evaluates a feature flag for any given <code className="font-mono">userId</code> and{' '}
                <code className="font-mono">userTier</code> cohort bucket (<code className="font-mono">0..99</code>).
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <form onSubmit={handleRunEvaluator} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
              Feature Flag Key
            </label>
            <select
              aria-label="Select feature flag to evaluate"
              value={evalFlagKey}
              onChange={(e) => setEvalFlagKey(e.target.value)}
              className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA]"
            >
              {flags.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.key} ({f.rolloutPercentage}%)
                </option>
              ))}
            </select>
          </div>

          <Input
            label="Subject / Player ID (`userId`)"
            value={evalUserId}
            onChange={(e) => setEvalUserId(e.target.value)}
            placeholder="e.g., player-uuid-123"
          />

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
              Player Tier (`userTier`)
            </label>
            <select
              aria-label="Select player tier to evaluate"
              value={evalUserTier}
              onChange={(e) => setEvalUserTier(e.target.value as PlayerTier)}
              className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA]"
            >
              {ALL_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" variant="secondary" isLoading={isEvaluating}>
            <Play className="w-3.5 h-3.5 text-[#18C986]" />
            Evaluate Cohort
          </Button>
        </form>

        {evalResult && (
          <div className="bg-[#000000] border border-[#274056] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono font-bold text-[#F5F7FA]">{evalResult.key}:</span>
              <Badge variant={evalResult.enabled ? 'success' : 'danger'}>
                {evalResult.enabled ? 'ENABLED FOR SUBJECT' : 'DISABLED FOR SUBJECT'}
              </Badge>
              <span className="font-mono text-[#8FA3B7]">Reason: {evalResult.reason}</span>
              {evalResult.bucket !== null && (
                <span className="font-mono text-[#18C986]">
                  SHA-256 Bucket: {evalResult.bucket} / 99 (Threshold: &lt;{evalResult.rolloutPercentage}%)
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-emerald-400">
              grantsPermissions: {String(evalResult.grantsPermissions)} • rbacAuthoritative: {String(evalResult.rbacAuthoritative)}
            </div>
          </div>
        )}
      </Card>

      {/* Create / Edit Feature Flag Modal */}
      {editorMode && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onSubmit={handleSaveFlagForm}
            className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <h3 className="text-base font-bold text-[#F5F7FA]">
                {editorMode === 'CREATE'
                  ? 'Create New Feature Flag'
                  : `Edit Feature Flag: ${editingFlag?.key}`}
              </h3>
              <button
                type="button"
                onClick={() => setEditorMode(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Flag Key (`key`)"
                value={formKey}
                disabled={editorMode === 'EDIT'}
                onChange={(e) => setFormKey(e.target.value.toLowerCase())}
                placeholder="e.g., tournament_brackets_v2"
                helperText="Lowercase snake_case or kebab-case (2–64 chars)"
              />

              <Input
                label="Display Name (`name`)"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g., Tournament Brackets V2"
              />
            </div>

            <Input
              label="Description (`description`)"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Explain what feature or circuit breaker this flag controls"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Deterministic Rollout Percentage (`0` – `100`)"
                type="number"
                min={0}
                max={100}
                value={String(formRollout)}
                onChange={(e) => setFormRollout(Number.parseInt(e.target.value, 10) || 0)}
                helperText="Uses SHA-256(key:userId) % 100"
              />

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-xs text-[#F5F7FA] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                    className="rounded border-[#274056] bg-[#000000]"
                  />
                  <span className="font-semibold">Enabled (`enabled: true`)</span>
                </label>

                <label className="flex items-center gap-2 text-xs text-[#F5F7FA] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formIsKillSwitch}
                    onChange={(e) => setFormIsKillSwitch(e.target.checked)}
                    className="rounded border-[#274056] bg-[#000000]"
                  />
                  <span className="font-semibold text-amber-400">
                    Designate as Operational Kill Switch (`isKillSwitch`)
                  </span>
                </label>
              </div>
            </div>

            {/* Allowed Player Tiers */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Target Player Tiers (`allowedTiers` — Leave empty for All Tiers)
              </label>
              <div className="flex flex-wrap gap-2">
                {ALL_TIERS.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => toggleTierSelection(tier)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono border ${
                      formTiers.includes(tier)
                        ? 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/50 font-bold'
                        : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                    }`}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>

            {/* Admin Role Visibility Metadata */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Admin Role UI Visibility (`allowedRoles` — UI Visibility Only, Never Grants RBAC)
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ADMIN_ROLES.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleRoleSelection(role)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono border ${
                      formRoles.includes(role)
                        ? 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/50 font-bold'
                        : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                    }`}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </div>

            <Input
              label="Mandatory Audit Reason (Min 5 Characters)"
              value={formReason}
              onChange={(e) => setFormReason(e.target.value)}
              placeholder="Explain why this flag is being created or updated"
            />

            <div className="flex justify-end gap-2 pt-3 border-t border-[#274056]">
              <Button variant="ghost" size="sm" type="button" onClick={() => setEditorMode(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="submit" isLoading={isSubmittingForm}>
                {editorMode === 'CREATE' ? 'Create Feature Flag' : 'Save Changes'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Toggle / Kill-Switch / Delete Confirmation Modal */}
      {actionModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                {actionModal.mode === 'KILL_SWITCH'
                  ? `${actionModal.targetEnabled ? 'Restore' : 'Trip'} Kill Switch: ${actionModal.flag.key}`
                  : actionModal.mode === 'DELETE'
                    ? `Delete Feature Flag: ${actionModal.flag.key}`
                    : `${actionModal.targetEnabled ? 'Enable' : 'Disable'} Flag: ${actionModal.flag.key}`}
              </h3>
            </div>

            <p className="text-xs text-[#8FA3B7]">
              {actionModal.mode === 'KILL_SWITCH'
                ? 'This operational circuit breaker action will be immediately persisted to PostgreSQL, broadcast via the transactional outbox to purge Redis caches, and logged in AdminAuditLog.'
                : 'Provide an auditable operational reason (minimum 5 characters) to execute this change.'}
            </p>

            <Input
              label="Mandatory Reason (Min 5 Characters)"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              placeholder="Enter operational justification…"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setActionModal(null)}>
                Cancel
              </Button>
              <Button
                variant={actionModal.mode === 'DELETE' || !actionModal.targetEnabled ? 'danger' : 'primary'}
                size="sm"
                onClick={handleExecuteActionModal}
                isLoading={isExecutingAction}
              >
                Confirm Action
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Flag Audit History Modal */}
      {historyFlag && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#274056] pb-3">
              <div>
                <h3 className="text-base font-bold text-[#F5F7FA]">
                  Feature Flag Audit History: <span className="font-mono text-[#18C986]">{historyFlag.key}</span>
                </h3>
                <p className="text-xs text-[#8FA3B7]">
                  Chronological record of creations, updates, toggles, and kill-switch events.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryFlag(null)}
                className="text-[#8FA3B7] hover:text-[#F5F7FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-3">
              {isLoadingHistory ? (
                <div className="py-8 text-center text-xs text-[#8FA3B7]">Loading audit trail…</div>
              ) : historyLogs.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#53677A]">
                  No audit records found for this feature flag.
                </div>
              ) : (
                historyLogs.map((log) => (
                  <div
                    key={log.id}
                    className="bg-[#000000] border border-[#274056] rounded-xl p-3.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-[#18C986]">{log.action}</span>
                      <span className="font-mono text-[11px] text-[#8FA3B7]">
                        {formatDate(log.createdAt)}
                      </span>
                    </div>
                    <div className="text-[#8FA3B7]">
                      Actor: <span className="font-mono text-[#F5F7FA]">{log.adminId}</span>
                    </div>
                    {log.metadata && (
                      <pre className="bg-[#0C1B2A] border border-[#274056] rounded-lg p-2.5 font-mono text-[11px] text-[#8FA3B7] overflow-x-auto">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
