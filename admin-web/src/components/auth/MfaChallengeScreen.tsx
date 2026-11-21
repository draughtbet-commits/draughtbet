'use client';

import React, { useState } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { authApi } from '@/lib/api/auth';
import type { MfaSetupResponse } from '@/lib/api/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ShieldCheck, KeyRound, AlertCircle, Copy, Check, LogOut } from 'lucide-react';

export function MfaChallengeScreen() {
  const { user, verifyMfaSession, recoverMfaSession, completeMfaEnrollment, logout } = useAuth();
  const isEnrolled = Boolean(user?.mfa?.enabled);

  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const handleStartEnrollment = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const provisioned = await authApi.setupMfa();
      setSetupData(provisioned);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to start MFA enrollment.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmEnrollment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await completeMfaEnrollment(code.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid verification code.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (mode === 'totp') {
        await verifyMfaSession(code.trim());
      } else {
        await recoverMfaSession(recoveryCode.trim());
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'MFA verification failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const copySecret = async () => {
    if (!setupData?.base32) return;
    try {
      await navigator.clipboard.writeText(setupData.base32);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex w-12 h-12 rounded-xl bg-[#0E2E2B] border border-[#18C986]/40 items-center justify-center text-[#18C986] shadow-lg mb-2">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
            {isEnrolled ? 'Multi-Factor Verification Required' : 'Admin MFA Enrollment Required'}
          </h1>
          <p className="text-xs text-[#8FA3B7]">
            Signed in as <span className="font-mono text-[#F5F7FA]">{user?.email}</span>. Security
            policy requires verified RFC-6238 TOTP MFA before accessing administrative tools.
          </p>
        </div>

        <Card className="bg-[#0C1B2A] border-[#274056] p-6 space-y-5 shadow-xl">
          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-start gap-2.5 text-xs text-rose-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {isEnrolled ? (
            <>
              <div className="flex gap-2 bg-[#000000] p-1 rounded-lg border border-[#274056]">
                <button
                  type="button"
                  onClick={() => {
                    setMode('totp');
                    setError(null);
                  }}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition-colors ${
                    mode === 'totp'
                      ? 'bg-[#0E2E2B] text-[#18C986] border border-[#18C986]/40'
                      : 'text-[#8FA3B7] hover:text-[#F5F7FA]'
                  }`}
                >
                  Authenticator Code
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('recovery');
                    setError(null);
                  }}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition-colors ${
                    mode === 'recovery'
                      ? 'bg-[#0E2E2B] text-[#18C986] border border-[#18C986]/40'
                      : 'text-[#8FA3B7] hover:text-[#F5F7FA]'
                  }`}
                >
                  Recovery Code
                </button>
              </div>

              <form onSubmit={handleVerifyChallenge} className="space-y-4">
                {mode === 'totp' ? (
                  <Input
                    label="6-Digit Authenticator Code"
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    autoFocus
                  />
                ) : (
                  <Input
                    label="Single-Use Recovery Code"
                    placeholder="XXXX-XXXX-XXXX"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                    required
                    autoFocus
                  />
                )}

                <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
                  {mode === 'totp' ? 'Verify & Continue' : 'Use Recovery Code'}
                </Button>
              </form>
            </>
          ) : !setupData ? (
            <div className="space-y-4">
              <p className="text-xs text-[#8FA3B7] leading-relaxed">
                Generate your personal TOTP secret key, add it to your authenticator app (Google
                Authenticator, 1Password, Authy), save the one-time recovery codes offline, and
                verify your first 6-digit code.
              </p>
              <Button
                type="button"
                variant="primary"
                className="w-full gap-2"
                onClick={handleStartEnrollment}
                isLoading={isSubmitting}
              >
                <KeyRound className="w-4 h-4" />
                <span>Generate TOTP Secret &amp; Recovery Codes</span>
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-[#000000] border border-[#274056] rounded-lg space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#F5F7FA]">Setup Secret (Base32)</span>
                  <button
                    type="button"
                    onClick={copySecret}
                    className="inline-flex items-center gap-1 text-[#18C986] hover:underline"
                  >
                    {copiedSecret ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedSecret ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <p className="font-mono text-xs text-[#18C986] break-all select-all">
                  {setupData.base32}
                </p>
                <p className="text-[11px] text-[#53677A] break-all font-mono">
                  {setupData.otpauthUrl}
                </p>
              </div>

              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg space-y-2">
                <p className="text-xs font-bold text-amber-300">
                  Save Single-Use Recovery Codes (Shown Once)
                </p>
                <div className="grid grid-cols-2 gap-1.5 font-mono text-xs text-[#F5F7FA]">
                  {setupData.recoveryCodes.map((rc) => (
                    <div
                      key={rc}
                      className="px-2 py-1 bg-[#000000] border border-[#274056] rounded text-center select-all"
                    >
                      {rc}
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={handleConfirmEnrollment} className="space-y-4">
                <Input
                  label="Confirm 6-Digit Code from Authenticator App"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
                <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
                  Activate Admin MFA &amp; Enter Console
                </Button>
              </form>
            </div>
          )}

          <div className="pt-3 border-t border-[#274056]/60 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-[#8FA3B7]"
              onClick={() => void logout()}
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
