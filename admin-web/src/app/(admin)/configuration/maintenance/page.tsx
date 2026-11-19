'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { ADMIN_ROLES, AdminRole } from '@/lib/permissions/roles';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import {
  MaintenanceStateItem,
  MaintenanceScope,
  MaintenanceAccessDecision,
  AuditLogItem
} from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/utils';
import {
  Wrench,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Power,
  PowerOff,
  RotateCcw,
  Play,
  Plus,
  Lock,
  Terminal,
  X
} from 'lucide-react';

const SCOPE_DETAILS: Array<{
  scope: MaintenanceScope;
  title: string;
  description: string;
  restrictedRoutes: string[];
  preservedRoutes: string[];
}> = [
  {
    scope: 'FULL_PLATFORM',
    title: 'Full Platform Maintenance (`FULL_PLATFORM`)',
    description:
      'Pauses all player gameplay, matchmaking, call-outs, wallet deposits/withdrawals, KYC submissions, and safer-play mutations.',
    restrictedRoutes: [
      '/api/v1/matches',
      '/api/v1/matchmaking',
      '/api/v1/callouts',
      '/api/v1/wallet',
      '/api/v1/verification',
      '/api/v1/safer-play',
      '/api/v1/notifications',
      '/api/v1/me'
    ],
    preservedRoutes: ['/api/v1/auth', '/api/v1/admin', '/webhooks', '/health', '/ready']
  },
  {
    scope: 'GAMEPLAY_ONLY',
    title: 'Gameplay & Matchmaking Only (`GAMEPLAY_ONLY`)',
    description:
      'Pauses active match routes, matchmaking queue entry, and call-out challenges while keeping player wallet and profile views available.',
    restrictedRoutes: ['/api/v1/matches', '/api/v1/matchmaking', '/api/v1/callouts'],
    preservedRoutes: ['/api/v1/wallet', '/api/v1/me', '/api/v1/auth', '/api/v1/admin']
  },
  {
    scope: 'MATCHMAKING_ONLY',
    title: 'New Matchmaking & Call-Outs Only (`MATCHMAKING_ONLY`)',
    description:
      'Prevents new matchmaking queue joins and new call-out acceptances while allowing already-active matches (`/api/v1/matches`) to play to completion.',
    restrictedRoutes: ['/api/v1/matchmaking', '/api/v1/callouts'],
    preservedRoutes: ['/api/v1/matches', '/api/v1/wallet', '/api/v1/auth', '/api/v1/admin']
  },
  {
    scope: 'FINANCIAL_ONLY',
    title: 'Financial Operations Only (`FINANCIAL_ONLY`)',
    description:
      'Pauses player wallet deposit intents and withdrawal submissions during payment gateway incidents while keeping gameplay unaffected.',
    restrictedRoutes: ['/api/v1/wallet'],
    preservedRoutes: ['/api/v1/matches', '/api/v1/matchmaking', '/api/v1/auth', '/api/v1/admin']
  }
];

export default function MaintenanceControlsPage() {
  const { user } = useAuth();
  const canRead = canAccessPermission(user, PERMISSIONS.MAINTENANCE_READ);
  const canManage = canAccessPermission(user, PERMISSIONS.MAINTENANCE_MANAGE);

  const [maintenance, setMaintenance] = useState<MaintenanceStateItem | null>(null);
  const [history, setHistory] = useState<AuditLogItem[]>([]);
  const [isLoading, setIsLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Configuration Form state
  const [scope, setScope] = useState<MaintenanceScope>('FULL_PLATFORM');
  const [headline, setHeadline] = useState('Platform Under Scheduled Maintenance');
  const [message, setMessage] = useState(
    'We are performing essential system updates. Gameplay and financial operations will resume shortly.'
  );
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [allowedIps, setAllowedIps] = useState<string[]>([]);
  const [ipInput, setIpInput] = useState('');
  const [allowedRoles, setAllowedRoles] = useState<AdminRole[]>(['SUPER_ADMIN']);
  const [configReason, setConfigReason] = useState('');
  const [isUpdatingConfig, setIsUpdatingConfig] = useState(false);

  // Confirmation Dialogs
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showEmergencyConfirm, setShowEmergencyConfirm] = useState(false);
  const [modalReason, setModalReason] = useState('');
  const [emergencyAckText, setEmergencyAckText] = useState('');
  const [isExecutingModal, setIsExecutingModal] = useState(false);

  // Access Evaluator state
  const [evalPath, setEvalPath] = useState('/api/v1/matchmaking/join');
  const [evalIp, setEvalIp] = useState('192.0.2.10');
  const [evalRole, setEvalRole] = useState<string>('NONE');
  const [evalDecision, setEvalDecision] = useState<MaintenanceAccessDecision | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);

  const loadMaintenanceData = useCallback(async () => {
    setError(null);
    try {
      const [stateRes, histRes] = await Promise.all([
        adminApi.getMaintenanceState(),
        adminApi.getMaintenanceHistory({ page: 1, limit: 20 })
      ]);

      const m = stateRes.maintenance;
      setMaintenance(m);
      setHistory(histRes.history || []);

      if (m) {
        setScope(m.scope);
        setHeadline(m.headline);
        setMessage(m.message);
        setAllowedIps(m.allowedIps || []);
        setAllowedRoles(
          m.allowedRoles?.includes('SUPER_ADMIN')
            ? m.allowedRoles
            : ['SUPER_ADMIN', ...(m.allowedRoles || [])]
        );
        setStartsAt(m.startsAt ? new Date(m.startsAt).toISOString().slice(0, 16) : '');
        setEndsAt(m.endsAt ? new Date(m.endsAt).toISOString().slice(0, 16) : '');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load maintenance state');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    (async () => {
      await loadMaintenanceData();
    })();
  }, [canRead, loadMaintenanceData]);

  const handleAddIp = () => {
    const trimmed = ipInput.trim();
    if (!trimmed) return;
    if (!allowedIps.includes(trimmed)) {
      setAllowedIps((prev) => [...prev, trimmed]);
    }
    setIpInput('');
  };

  const handleRemoveIp = (ip: string) => {
    setAllowedIps((prev) => prev.filter((item) => item !== ip));
  };

  const toggleAllowedRole = (role: AdminRole) => {
    // SUPER_ADMIN can never be deselected (Accidental Lockout Protection)
    if (role === 'SUPER_ADMIN') return;
    setAllowedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleSaveConfiguration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (configReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A change reason of at least 5 characters is required to update maintenance configuration.'
      });
      return;
    }

    setIsUpdatingConfig(true);
    setBanner(null);
    try {
      const res = await adminApi.updateMaintenanceState({
        scope,
        headline: headline.trim(),
        message: message.trim(),
        allowedIps,
        allowedRoles: allowedRoles.includes('SUPER_ADMIN')
          ? allowedRoles
          : ['SUPER_ADMIN', ...allowedRoles],
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        reason: configReason.trim()
      });
      setMaintenance(res.maintenance);
      setConfigReason('');
      await loadMaintenanceData();
      setBanner({
        type: 'success',
        message: `Maintenance configuration updated (Scope: ${res.maintenance.scope}, Status: ${res.maintenance.effectiveStatus}).`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update maintenance settings'
      });
    } finally {
      setIsUpdatingConfig(false);
    }
  };

  const handleConfirmEnable = async () => {
    if (modalReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'An operational reason of at least 5 characters is required to enable maintenance.'
      });
      return;
    }

    setIsExecutingModal(true);
    setBanner(null);
    try {
      const res = await adminApi.enableMaintenance({
        scope,
        headline: headline.trim(),
        message: message.trim(),
        allowedIps,
        allowedRoles: allowedRoles.includes('SUPER_ADMIN')
          ? allowedRoles
          : ['SUPER_ADMIN', ...allowedRoles],
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        reason: modalReason.trim()
      });
      setMaintenance(res.maintenance);
      setShowEnableConfirm(false);
      setModalReason('');
      await loadMaintenanceData();
      setBanner({
        type: 'success',
        message: `Maintenance mode ${
          res.maintenance.effectiveStatus === 'SCHEDULED' ? 'scheduled' : 'enabled'
        } for scope ${res.maintenance.scope}.`
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to enable maintenance mode'
      });
    } finally {
      setIsExecutingModal(false);
    }
  };

  const handleConfirmDisable = async () => {
    if (modalReason.trim().length < 5) {
      setBanner({
        type: 'error',
        message: 'A reason of at least 5 characters is required to disable maintenance.'
      });
      return;
    }

    setIsExecutingModal(true);
    setBanner(null);
    try {
      const res = await adminApi.disableMaintenance(modalReason.trim());
      setMaintenance(res.maintenance);
      setShowDisableConfirm(false);
      setModalReason('');
      await loadMaintenanceData();
      setBanner({
        type: 'success',
        message: 'Maintenance mode disabled. Normal player traffic restored.'
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to disable maintenance mode'
      });
    } finally {
      setIsExecutingModal(false);
    }
  };

  const handleConfirmEmergencyReset = async () => {
    if (emergencyAckText.trim() !== 'RESET') {
      setBanner({
        type: 'error',
        message: 'Please type RESET to confirm the emergency maintenance recovery action.'
      });
      return;
    }

    setIsExecutingModal(true);
    setBanner(null);
    try {
      const res = await adminApi.emergencyResetMaintenance(
        modalReason.trim() || 'Emergency maintenance recovery reset from Admin Panel'
      );
      setMaintenance(res.maintenance);
      setShowEmergencyConfirm(false);
      setModalReason('');
      setEmergencyAckText('');
      await loadMaintenanceData();
      setBanner({
        type: 'success',
        message: 'Emergency recovery completed: maintenance disabled and Redis caches purged.'
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Emergency reset failed'
      });
    } finally {
      setIsExecutingModal(false);
    }
  };

  const handleRunEvaluator = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsEvaluating(true);
    try {
      const res = await adminApi.evaluateMaintenanceAccess({
        path: evalPath.trim() || '/',
        ip: evalIp.trim() || null,
        adminRoles: evalRole === 'NONE' ? [] : [evalRole as AdminRole]
      });
      setEvalDecision(res.decision);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to evaluate maintenance access'
      });
    } finally {
      setIsEvaluating(false);
    }
  };

  const activeScopeDetail =
    SCOPE_DETAILS.find((s) => s.scope === scope) || SCOPE_DETAILS[0];

  return (
    <div className="space-y-6">
      {/* Live Maintenance Operational Status Header */}
      <div
        className={`rounded-xl p-5 border flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 ${
          maintenance?.effectivelyActive
            ? 'bg-rose-500/10 border-rose-500/40'
            : maintenance?.effectiveStatus === 'SCHEDULED'
              ? 'bg-amber-500/10 border-amber-500/40'
              : 'bg-[#0C1B2A] border-[#274056]'
        }`}
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <Wrench
              className={`w-5 h-5 ${
                maintenance?.effectivelyActive ? 'text-rose-400' : 'text-[#18C986]'
              }`}
            />
            <h2 className="text-lg font-bold text-[#F5F7FA]">
              Platform Maintenance Status:{' '}
              <span className="font-mono">{maintenance?.effectiveStatus || 'INACTIVE'}</span>
            </h2>
            <Badge
              variant={
                maintenance?.effectivelyActive
                  ? 'danger'
                  : maintenance?.effectiveStatus === 'SCHEDULED'
                    ? 'warning'
                    : 'success'
              }
            >
              {maintenance?.effectivelyActive
                ? `BLOCKING (${maintenance.scope})`
                : maintenance?.effectiveStatus === 'SCHEDULED'
                  ? `SCHEDULED (${maintenance.scope})`
                  : 'NORMAL OPERATION'}
            </Badge>
          </div>
          <p className="text-xs text-[#8FA3B7]">
            {maintenance?.headline} — {maintenance?.message}
          </p>
          <div className="text-[11px] font-mono text-[#8FA3B7] pt-1">
            Permanently Exempt Surfaces: {(maintenance?.exemptPrefixes || ['/health', '/ready', '/webhooks', '/api/v1/auth', '/api/v1/admin']).join(', ')}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setIsLoading(true);
              void loadMaintenanceData();
            }}
            isLoading={isLoading}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>

          {canManage && (
            <>
              {maintenance?.active ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setModalReason('');
                    setShowDisableConfirm(true);
                  }}
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  Disable Maintenance
                </Button>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setModalReason('');
                    setShowEnableConfirm(true);
                  }}
                >
                  <Power className="w-3.5 h-3.5" />
                  Enable Maintenance…
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setModalReason('');
                  setEmergencyAckText('');
                  setShowEmergencyConfirm(true);
                }}
              >
                <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
                Emergency Reset
              </Button>
            </>
          )}
        </div>
      </div>

      {banner && (
        <div
          role="status"
          className={`rounded-xl p-4 border flex items-center justify-between text-xs ${
            banner.type === 'success'
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

      {error && (
        <Card className="p-4 border-rose-500/30 text-xs text-rose-300">{error}</Card>
      )}

      {/* Scope Comparison & Configuration Form */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Maintenance Scope Matrix */}
        <Card className="space-y-4">
          <CardHeader>
            <div>
              <CardTitle>Maintenance Scope Matrix &amp; Lockout Safeguards</CardTitle>
              <CardDescription>
                Select or inspect the exact player API surfaces affected by each maintenance scope.
              </CardDescription>
            </div>
            <Badge variant="gold">Zero Admin Lockout</Badge>
          </CardHeader>

          <div className="space-y-3">
            {SCOPE_DETAILS.map((item) => {
              const isSelected = scope === item.scope;
              return (
                <div
                  key={item.scope}
                  onClick={() => canManage && setScope(item.scope)}
                  className={`rounded-xl p-3.5 border transition-colors ${
                    canManage ? 'cursor-pointer' : ''
                  } ${
                    isSelected
                      ? 'bg-[#0E2E2B]/30 border-[#18C986] text-[#F5F7FA]'
                      : 'bg-[#000000] border-[#274056] text-[#8FA3B7]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#F5F7FA]">{item.title}</span>
                    {isSelected && <Badge variant="gold">Selected Scope</Badge>}
                  </div>
                  <p className="text-xs text-[#8FA3B7] mt-1">{item.description}</p>
                  <div className="mt-2 pt-2 border-t border-[#274056]/60 flex flex-wrap gap-1.5 text-[10px] font-mono">
                    <span className="text-rose-400 font-semibold">Blocks:</span>
                    {item.restrictedRoutes.map((r) => (
                      <span
                        key={r}
                        className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Right Column: User-Facing Banner, Schedule Window & Bypass Controls */}
        <Card className="space-y-4">
          <CardHeader>
            <div>
              <CardTitle>Banner Message, Schedule Window &amp; Bypass Controls</CardTitle>
              <CardDescription>
                Configure user-facing maintenance messaging, scheduled start/end times, and IP/Role allowlists.
              </CardDescription>
            </div>
            {!canManage && <Badge variant="default">Read Only</Badge>}
          </CardHeader>

          <form onSubmit={handleSaveConfiguration} className="space-y-4">
            <Input
              label="User-Facing Banner Headline (`headline` — 3–140 chars)"
              disabled={!canManage}
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              helperText="Plain text only; raw HTML and scripts are rejected."
            />

            <div className="space-y-1.5">
              <label
                htmlFor="maint-message-textarea"
                className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]"
              >
                User-Facing Maintenance Message (`message` — 10–1,000 chars)
              </label>
              <textarea
                id="maint-message-textarea"
                rows={3}
                disabled={!canManage}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full p-3 bg-[#000000] border border-[#274056] rounded-lg text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986] disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Scheduled Window Start (`startsAt`)"
                type="datetime-local"
                disabled={!canManage}
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                helperText="Leave blank for immediate effect when enabled."
              />
              <Input
                label="Scheduled Window End (`endsAt` — Max 7 Days)"
                type="datetime-local"
                disabled={!canManage}
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                helperText="Automatically expires when endsAt is reached."
              />
            </div>

            {/* Allowed Roles with SUPER_ADMIN Lockout Protection */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Authorized Bypass Roles (`allowedRoles` — `SUPER_ADMIN` Locked Against Lockout)
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ADMIN_ROLES.map((role) => {
                  const isSuper = role === 'SUPER_ADMIN';
                  const isSelected = isSuper || allowedRoles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      disabled={!canManage || isSuper}
                      onClick={() => toggleAllowedRole(role)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-mono border inline-flex items-center gap-1 ${
                        isSelected
                          ? 'bg-[#0E2E2B] text-[#18C986] border-[#18C986]/50 font-bold'
                          : 'bg-[#000000] text-[#8FA3B7] border-[#274056]'
                      } disabled:cursor-not-allowed`}
                    >
                      {isSuper && <Lock className="w-3 h-3" />}
                      {role}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Allowed IP / CIDR Allowlist */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Allowed IPv4 / IPv6 / CIDR Bypass List (`allowedIps`)
              </label>
              <div className="flex flex-wrap gap-1.5 bg-[#000000] border border-[#274056] rounded-lg p-2.5 min-h-[40px]">
                {allowedIps.length === 0 ? (
                  <span className="text-xs text-[#53677A]">No bypass IPs configured.</span>
                ) : (
                  allowedIps.map((ip) => (
                    <span
                      key={ip}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#132638] border border-[#274056] font-mono text-xs text-[#F5F7FA]"
                    >
                      {ip}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => handleRemoveIp(ip)}
                          className="text-[#8FA3B7] hover:text-rose-400"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  ))
                )}
              </div>

              {canManage && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g., 127.0.0.1 or 10.0.0.0/24"
                    value={ipInput}
                    onChange={(e) => setIpInput(e.target.value)}
                    className="h-9 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA] flex-1"
                  />
                  <Button type="button" variant="secondary" size="sm" onClick={handleAddIp}>
                    <Plus className="w-3.5 h-3.5" />
                    Add IP
                  </Button>
                </div>
              )}
            </div>

            {canManage && (
              <>
                <Input
                  label="Mandatory Audit Reason (Min 5 Characters)"
                  value={configReason}
                  onChange={(e) => setConfigReason(e.target.value)}
                  placeholder="e.g., Prepare banner and window for scheduled database maintenance"
                />

                <div className="flex justify-end pt-2">
                  <Button type="submit" variant="secondary" size="sm" isLoading={isUpdatingConfig}>
                    Save Maintenance Configuration
                  </Button>
                </div>
              </>
            )}
          </form>
        </Card>
      </div>

      {/* Live Maintenance Request Access Evaluator & Out-of-Band CLI Recovery Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 space-y-4">
          <CardHeader>
            <div>
              <CardTitle>Maintenance Access Evaluator (`POST /admin/maintenance/evaluate`)</CardTitle>
              <CardDescription>
                Simulate how the backend middleware evaluates a specific request path, IP address, and role under the current maintenance state.
              </CardDescription>
            </div>
          </CardHeader>

          <form onSubmit={handleRunEvaluator} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <Input
              label="Request Path (`path`)"
              value={evalPath}
              onChange={(e) => setEvalPath(e.target.value)}
              placeholder="/api/v1/matchmaking/join"
            />
            <Input
              label="Caller IP (`ip`)"
              value={evalIp}
              onChange={(e) => setEvalIp(e.target.value)}
              placeholder="192.0.2.10"
            />
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8FA3B7]">
                Caller Role
              </label>
              <select
                aria-label="Simulated caller role"
                value={evalRole}
                onChange={(e) => setEvalRole(e.target.value)}
                className="w-full h-10 px-3 bg-[#000000] border border-[#274056] rounded-lg text-xs font-mono text-[#F5F7FA]"
              >
                <option value="NONE">Regular Player (No Admin Role)</option>
                {ADMIN_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="secondary" isLoading={isEvaluating}>
              <Play className="w-3.5 h-3.5 text-[#18C986]" />
              Test Access
            </Button>
          </form>

          {evalDecision && (
            <div className="bg-[#000000] border border-[#274056] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono font-bold text-[#F5F7FA]">{evalDecision.path}:</span>
                <Badge variant={evalDecision.allowed ? 'success' : 'danger'}>
                  {evalDecision.allowed ? 'ALLOWED (200)' : 'BLOCKED (503 MAINTENANCE_MODE)'}
                </Badge>
                <span className="font-mono text-[#18C986]">Reason: {evalDecision.reason}</span>
              </div>
              {evalDecision.scope && (
                <span className="font-mono text-[#8FA3B7]">Scope: {evalDecision.scope}</span>
              )}
            </div>
          )}
        </Card>

        {/* Out-of-Band CLI Recovery Card */}
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-[#18C986]" />
            <CardTitle className="text-sm">Out-of-Band CLI Recovery</CardTitle>
          </div>
          <p className="text-xs text-[#8FA3B7]">
            If the admin web interface is unreachable during a network incident, operators can immediately disable
            maintenance directly against PostgreSQL and flush Redis caches via:
          </p>
          <pre className="bg-[#000000] border border-[#274056] rounded-lg p-3 font-mono text-[11px] text-[#18C986] overflow-x-auto">
            node backend/scripts/emergencyMaintenanceReset.js
          </pre>
          <p className="text-[11px] text-[#53677A]">
            Sets <code className="font-mono">MaintenanceState.active = false</code>, purges{' '}
            <code className="font-mono">maintenance:state:v2</code>, and publishes{' '}
            <code className="font-mono">platform:maintenance:invalidated</code>.
          </p>
        </Card>
      </div>

      {/* Maintenance Audit History */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Maintenance Operations Audit History</CardTitle>
            <CardDescription>
              Immutable record of all maintenance activations, schedule updates, deactivations, and emergency resets.
            </CardDescription>
          </div>
        </CardHeader>

        {history.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#53677A]">
            No maintenance audit records found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Reason &amp; State Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#274056] text-xs">
                {history.map((log) => {
                  const meta = (log.metadata || {}) as {
                    reason?: string;
                    after?: { scope?: string; active?: boolean };
                  };
                  return (
                    <tr key={log.id} className="hover:bg-[#132638]/60">
                      <td className="py-3 px-4 font-mono text-[11px] text-[#8FA3B7]">
                        {formatDate(log.createdAt)}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-[#18C986]">{log.action}</td>
                      <td className="py-3 px-4 font-mono text-[#F5F7FA]">{log.adminId}</td>
                      <td className="py-3 px-4 text-[#8FA3B7]">
                        <div className="text-[#F5F7FA] font-medium">{meta.reason || '—'}</div>
                        {meta.after && (
                          <div className="font-mono text-[11px] text-[#53677A]">
                            active: {String(meta.after.active)} • scope: {meta.after.scope}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Enable Maintenance Confirmation Modal */}
      {showEnableConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-rose-500/40 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0" />
              <div>
                <h3 className="text-base font-bold text-[#F5F7FA]">
                  Confirm Maintenance Mode Activation
                </h3>
                <p className="text-xs text-[#8FA3B7]">
                  Review the affected scope and operational impact before enabling maintenance mode.
                </p>
              </div>
            </div>

            <div className="bg-[#000000] border border-[#274056] rounded-xl p-4 text-xs space-y-2">
              <div className="flex justify-between">
                <span className="text-[#8FA3B7]">Target Scope:</span>
                <Badge variant="danger">{activeScopeDetail.scope}</Badge>
              </div>
              <p className="text-[#8FA3B7]">{activeScopeDetail.description}</p>
              <div className="pt-2 border-t border-[#274056] space-y-1">
                <div className="font-semibold text-rose-400">
                  Restricted Player Surfaces ({activeScopeDetail.restrictedRoutes.length}):
                </div>
                <div className="font-mono text-[11px] text-[#F5F7FA]">
                  {activeScopeDetail.restrictedRoutes.join(', ')}
                </div>
              </div>
              <div className="pt-2 border-t border-[#274056] space-y-1">
                <div className="font-semibold text-emerald-400">
                  Preserved Surfaces (Lockout Protection):
                </div>
                <div className="font-mono text-[11px] text-[#8FA3B7]">
                  /api/v1/auth/*, /api/v1/admin/*, /webhooks/*, /health, /ready, plus SUPER_ADMIN
                </div>
              </div>
            </div>

            <Input
              label="Mandatory Activation Reason (Min 5 Characters)"
              value={modalReason}
              onChange={(e) => setModalReason(e.target.value)}
              placeholder="e.g., Emergency Paystack webhook maintenance window"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowEnableConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirmEnable}
                isLoading={isExecutingModal}
              >
                Confirm &amp; Enable Maintenance
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Disable Maintenance Confirmation Modal */}
      {showDisableConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-[#274056] rounded-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-base font-bold text-[#F5F7FA]">Disable Maintenance Mode</h3>
            <p className="text-xs text-[#8FA3B7]">
              This will immediately restore normal player access across all platform routes and broadcast a cache
              invalidation event.
            </p>
            <Input
              label="Mandatory Deactivation Reason (Min 5 Characters)"
              value={modalReason}
              onChange={(e) => setModalReason(e.target.value)}
              placeholder="e.g., Maintenance window completed and verified"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowDisableConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirmDisable}
                isLoading={isExecutingModal}
              >
                Disable Maintenance
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Emergency Reset Confirmation Modal */}
      {showEmergencyConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0C1B2A] border border-rose-500/50 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-rose-400">
              <ShieldAlert className="w-6 h-6 shrink-0" />
              <h3 className="text-base font-bold text-[#F5F7FA]">
                Emergency Maintenance Reset
              </h3>
            </div>
            <p className="text-xs text-[#8FA3B7]">
              This emergency recovery action immediately forces <code className="font-mono">MaintenanceState.active = false</code>,
              clears any scheduled window timestamps, purges the Redis <code className="font-mono">maintenance:state:v2</code>{' '}
              cache, and records an emergency audit event.
            </p>

            <Input
              label="Type RESET to Confirm Emergency Recovery"
              value={emergencyAckText}
              onChange={(e) => setEmergencyAckText(e.target.value)}
              placeholder="RESET"
            />

            <Input
              label="Recovery Reason"
              value={modalReason}
              onChange={(e) => setModalReason(e.target.value)}
              placeholder="Emergency maintenance recovery reset"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowEmergencyConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={emergencyAckText.trim() !== 'RESET'}
                onClick={handleConfirmEmergencyReset}
                isLoading={isExecutingModal}
              >
                Execute Emergency Reset
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
