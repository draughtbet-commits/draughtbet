'use client';

import React, { useState } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { authApi } from '@/lib/api/auth';
import type { MfaSetupResponse } from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { RoleBadge } from '@/components/shell/RoleBadge';
import { ROLE_DESCRIPTIONS } from '@/lib/permissions/roles';
import { ShieldCheck, User, KeyRound, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';

export default function ProfilePage() {
  const { user, refreshProfile } = useAuth();
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [freshRecoveryCodes, setFreshRecoveryCodes] = useState<string[] | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaSuccess, setMfaSuccess] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  const mfa = user?.mfa;

  const handleProvisionMfa = async () => {
    setMfaError(null);
    setMfaSuccess(null);
    setMfaBusy(true);
    try {
      const res = await authApi.setupMfa(mfa?.enabled ? totpCode.trim() : undefined);
      setSetupData(res);
      setTotpCode('');
      setMfaSuccess('TOTP secret provisioned. Save recovery codes and verify your first 6-digit code.');
    } catch (err: unknown) {
      setMfaError(err instanceof Error ? err.message : 'Unable to provision MFA.');
    } finally {
      setMfaBusy(false);
    }
  };

  const handleEnableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setMfaError(null);
    setMfaSuccess(null);
    setMfaBusy(true);
    try {
      await authApi.enableMfa(totpCode.trim());
      setSetupData(null);
      setTotpCode('');
      await refreshProfile();
      setMfaSuccess('Admin MFA is now enabled and active for this session.');
    } catch (err: unknown) {
      setMfaError(err instanceof Error ? err.message : 'Invalid TOTP verification code.');
    } finally {
      setMfaBusy(false);
    }
  };

  const handleRegenerateCodes = async () => {
    setMfaError(null);
    setMfaSuccess(null);
    setMfaBusy(true);
    try {
      const res = await authApi.regenerateRecoveryCodes(totpCode.trim());
      setFreshRecoveryCodes(res.recoveryCodes);
      setTotpCode('');
      await refreshProfile();
      setMfaSuccess('Generated fresh recovery codes. Previous unused codes have been invalidated.');
    } catch (err: unknown) {
      setMfaError(err instanceof Error ? err.message : 'Enter a valid 6-digit TOTP code to regenerate recovery codes.');
    } finally {
      setMfaBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[#F5F7FA]">
          Admin Profile &amp; Security
        </h1>
        <p className="text-xs text-[#8FA3B7] mt-1">
          Review operator identity, assigned roles, MFA enrollment, and effective permissions matrix.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Identity & Roles */}
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <User className="w-4 h-4 text-[#18C986]" />
                Operator Identity
              </CardTitle>
            </CardHeader>
            <div className="space-y-3 text-xs">
              <div>
                <span className="text-[#53677A] block">Operator ID:</span>
                <span className="font-mono text-[#F5F7FA] text-[11px] select-all">
                  {user?.id}
                </span>
              </div>
              <div>
                <span className="text-[#53677A] block">Email:</span>
                <span className="font-semibold text-[#F5F7FA]">{user?.email}</span>
              </div>
              <div>
                <span className="text-[#53677A] block">Username:</span>
                <span className="text-[#F5F7FA]">{user?.username || '—'}</span>
              </div>
              <div>
                <span className="text-[#53677A] block">Full Name:</span>
                <span className="text-[#F5F7FA]">{user?.fullName || '—'}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Assigned Roles</CardTitle>
              <CardDescription>Roles control access to backend domains</CardDescription>
            </CardHeader>
            <div className="space-y-3">
              {user?.roles?.map((role) => (
                <div key={role} className="p-3 bg-[#132638] border border-[#274056] rounded-lg space-y-1">
                  <div className="flex items-center justify-between">
                    <RoleBadge role={role} />
                  </div>
                  <p className="text-[11px] text-[#8FA3B7] mt-1">
                    {ROLE_DESCRIPTIONS[role]}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right Column: Security, MFA & Permissions */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="w-4 h-4 text-[#18C986]" />
                Authentication &amp; Security
              </CardTitle>
              <CardDescription>
                Cookie-isolated sessions, CSRF defense, RBAC, and RFC-6238 TOTP MFA
              </CardDescription>
            </CardHeader>
            <div className="space-y-3 text-xs text-[#8FA3B7]">
              <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-semibold text-[#F5F7FA] block">HttpOnly Cookie Sessions</span>
                  <span className="text-[11px]">
                    Rotated HttpOnly access/refresh cookies with reuse detection and signed CSRF protection
                  </span>
                </div>
                <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Active
                </span>
              </div>
              <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-semibold text-[#F5F7FA] block">Role-Based Access Control</span>
                  <span className="text-[11px]">Server-enforced authorization policies for 6 distinct roles</span>
                </div>
                <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Enforced
                </span>
              </div>
              <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold text-[#F5F7FA] block flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-[#18C986]" />
                      Multi-Factor Authentication (TOTP)
                    </span>
                    <span className="text-[11px]">
                      {mfa?.enabled
                        ? `Enabled · ${mfa.recoveryCodesRemaining} unused recovery code(s) remaining`
                        : 'Not enabled — enroll an authenticator app for operator MFA'}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                      mfa?.enabled
                        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                        : 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                    }`}
                  >
                    {mfa?.enabled ? 'Enabled' : 'Not Enrolled'}
                  </span>
                </div>

                {mfaError && (
                  <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 flex items-center gap-2 text-rose-400">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{mfaError}</span>
                  </div>
                )}
                {mfaSuccess && (
                  <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2 text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{mfaSuccess}</span>
                  </div>
                )}

                {!mfa?.enabled && !setupData && (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={handleProvisionMfa}
                    isLoading={mfaBusy}
                  >
                    Set Up Authenticator MFA
                  </Button>
                )}

                {setupData && (
                  <form onSubmit={handleEnableMfa} className="space-y-3 pt-2 border-t border-[#274056]">
                    <div className="p-2.5 bg-[#000000] border border-[#274056] rounded space-y-1">
                      <div className="text-[11px] font-semibold text-[#F5F7FA]">Secret (Base32):</div>
                      <div className="font-mono text-[#18C986] break-all select-all">{setupData.base32}</div>
                      <div className="text-[10px] text-[#53677A] font-mono break-all">{setupData.otpauthUrl}</div>
                    </div>
                    <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded space-y-1.5">
                      <div className="text-[11px] font-semibold text-amber-300">
                        Single-Use Recovery Codes (store offline):
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px] text-[#F5F7FA]">
                        {setupData.recoveryCodes.map((rc) => (
                          <div key={rc} className="px-2 py-1 bg-[#000000] rounded text-center select-all">
                            {rc}
                          </div>
                        ))}
                      </div>
                    </div>
                    <Input
                      label="Enter 6-Digit Authenticator Code"
                      placeholder="123456"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                      inputMode="numeric"
                      required
                    />
                    <Button type="submit" size="sm" variant="primary" isLoading={mfaBusy}>
                      Confirm &amp; Enable MFA
                    </Button>
                  </form>
                )}

                {mfa?.enabled && (
                  <div className="space-y-2.5 pt-2 border-t border-[#274056]">
                    <div className="flex flex-col sm:flex-row gap-2 items-end">
                      <div className="flex-1 w-full">
                        <Input
                          label="Current 6-Digit TOTP Code (required for MFA changes)"
                          placeholder="123456"
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                          inputMode="numeric"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={handleRegenerateCodes}
                        isLoading={mfaBusy}
                        disabled={totpCode.length !== 6}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Regenerate Recovery Codes</span>
                      </Button>
                    </div>
                    {freshRecoveryCodes && (
                      <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded space-y-1.5">
                        <div className="text-[11px] font-semibold text-amber-300">
                          New Recovery Codes (shown once):
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px] text-[#F5F7FA]">
                          {freshRecoveryCodes.map((rc) => (
                            <div key={rc} className="px-2 py-1 bg-[#000000] rounded text-center select-all">
                              {rc}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Effective Permissions Matrix */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Effective Permissions</CardTitle>
              <CardDescription>
                Granted permissions based on active role assignments
              </CardDescription>
            </CardHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {user?.permissions?.map((perm) => (
                <div
                  key={perm}
                  className="p-2.5 bg-[#132638] border border-[#274056] rounded flex items-center justify-between"
                >
                  <span className="font-mono text-[#F5F7FA]">{perm}</span>
                  <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">
                    Granted
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
