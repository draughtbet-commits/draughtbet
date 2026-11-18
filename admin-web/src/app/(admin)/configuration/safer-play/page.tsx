'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { adminApi } from '@/lib/api/admin';
import { SaferPlayRestrictionItem } from '@/lib/api/types';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  HeartHandshake,
  Clock,
  ShieldAlert,
  Lock,
  CheckCircle2,
  UserCheck
} from 'lucide-react';

export default function SaferPlayConfigurationPage() {
  const { user } = useAuth();
  const canReadRestrictions =
    canAccessPermission(user, PERMISSIONS.RISK_REVIEW) ||
    canAccessPermission(user, PERMISSIONS.SAFER_PLAY_LIFT);

  const [activeRestrictions, setActiveRestrictions] = useState<SaferPlayRestrictionItem[]>([]);
  const [restrictionsTotal, setRestrictionsTotal] = useState<number>(0);

  useEffect(() => {
    if (!canReadRestrictions) return;
    let mounted = true;
    (async () => {
      try {
        const res = await adminApi.getSaferPlayRestrictions({ page: 1, limit: 10, type: 'all' });
        if (mounted) {
          setActiveRestrictions(res.restrictions || res.items || []);
          setRestrictionsTotal(res.total || 0);
        }
      } catch {
        // Non-blocking operational summary
      }
    })();
    return () => {
      mounted = false;
    };
  }, [canReadRestrictions]);

  return (
    <DomainConfigWorkspace
      domains={['SAFER_PLAY']}
      title="Safer-Play Policy & Player Protection Controls"
      subtitle="Configure mandatory cooling-off windows for deposit/stake limit raises and minimum durations for timeouts and self-exclusion."
      impactNotice="MAKER-CHECKER REQUIRED: Changes to safer-play policy require independent reviewer approval. Global policy updates never weaken or lift an individual player's active timeout, deposit/stake ceiling, or self-exclusion."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        const setIntField = (
          key: keyof typeof draftPayload.saferPlay,
          rawVal: string
        ) => {
          const parsed = Number.parseInt(rawVal, 10);
          updateDraftPayload((prev) => {
            prev.saferPlay[key] = Number.isNaN(parsed) ? 0 : parsed;
            return prev;
          });
        };

        return (
          <div className="space-y-6">
            {/* Non-Weakening & Anti-Loss-Chasing Guarantee Banner */}
            <div className="bg-[#15181D] border border-emerald-500/30 rounded-xl p-4 flex items-start gap-3">
              <HeartHandshake className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-xs space-y-1">
                <div className="font-bold text-[#F4F2ED]">
                  Responsible Gaming &amp; Individual Protection Immutability Invariant
                </div>
                <p className="text-[#9CA3AF]">
                  1. Lowering a personal deposit or stake limit takes effect <strong>immediately</strong>, whereas
                  raising an existing limit is held in <code className="font-mono">pendingDepositLimitMinorUnits</code>{' '}
                  / <code className="font-mono">pendingStakeLimitMinorUnits</code> until the configured cooling-off
                  window elapses.
                  <br />
                  2. Active player self-exclusions (<code className="font-mono">selfExcludedUntil</code>) and timeouts (
                  <code className="font-mono">timeoutUntil</code>) are enforced server-side across all devices and
                  sessions and are never shortened or cleared by global configuration changes.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card 1: Cooling-Off & Minimum Protection Floors */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Clock className="w-5 h-5 text-[#E7B24A]" />
                    <div>
                      <CardTitle>Cooling-Off &amp; Minimum Protection Floors</CardTitle>
                      <CardDescription>
                        Authoritative policy floors enforced by <code className="font-mono">SaferPlayService</code>.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Restricted (Maker-Checker)</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <Input
                    label="Limit Raise Cooling-Off Hours (`saferPlay.limitRaiseCoolingHours`)"
                    type="number"
                    min={24}
                    max={168}
                    disabled={!canEdit}
                    value={String(draftPayload.saferPlay.limitRaiseCoolingHours)}
                    onChange={(e) => setIntField('limitRaiseCoolingHours', e.target.value)}
                    error={fieldErrors['saferPlay.limitRaiseCoolingHours']}
                    helperText={`Current Active: ${activePayload.saferPlay.limitRaiseCoolingHours} hours • Constraint: 24 – 168 hours (1 – 7 days). Synchronized with PlatformSettings.limitRaiseCoolingHours.`}
                  />

                  <Input
                    label="Minimum Timeout Break Duration Minutes (`saferPlay.minTimeoutDurationMinutes`)"
                    type="number"
                    min={15}
                    max={1440}
                    disabled={!canEdit}
                    value={String(draftPayload.saferPlay.minTimeoutDurationMinutes)}
                    onChange={(e) => setIntField('minTimeoutDurationMinutes', e.target.value)}
                    error={fieldErrors['saferPlay.minTimeoutDurationMinutes']}
                    helperText={`Current Active: ${activePayload.saferPlay.minTimeoutDurationMinutes} minutes • Constraint: 15 – 1,440 minutes (15m – 24h)`}
                  />

                  <Input
                    label="Minimum Hard Self-Exclusion Days (`saferPlay.minSelfExclusionDays`)"
                    type="number"
                    min={180}
                    max={3650}
                    disabled={!canEdit}
                    value={String(draftPayload.saferPlay.minSelfExclusionDays)}
                    onChange={(e) => setIntField('minSelfExclusionDays', e.target.value)}
                    error={fieldErrors['saferPlay.minSelfExclusionDays']}
                    helperText={`Current Active: ${activePayload.saferPlay.minSelfExclusionDays} days • Constraint: 180 – 3,650 days (6 months – 10 years)`}
                  />
                </div>
              </Card>

              {/* Card 2: Server Enforcement Matrix & Live Protections Summary */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <ShieldAlert className="w-5 h-5 text-emerald-400" />
                    <div>
                      <CardTitle>Server-Side Safer-Play Enforcement Matrix</CardTitle>
                      <CardDescription>
                        How safer-play protections gate player operations in real time.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="success">Enforced Across Devices</Badge>
                </CardHeader>

                <div className="space-y-3 text-xs">
                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 space-y-1">
                    <div className="flex items-center justify-between font-bold text-[#F4F2ED]">
                      <span>Daily Deposit Ceiling (`depositLimitMinorUnits`)</span>
                      <Badge variant="info">Deposit Intent Gate</Badge>
                    </div>
                    <p className="text-[#9CA3AF]">
                      Checked before creating any Paystack or Flutterwave <code className="font-mono">DepositIntent</code>.
                    </p>
                  </div>

                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 space-y-1">
                    <div className="flex items-center justify-between font-bold text-[#F4F2ED]">
                      <span>Per-Match Stake Ceiling (`stakeLimitMinorUnits`)</span>
                      <Badge variant="info">Funding Gate</Badge>
                    </div>
                    <p className="text-[#9CA3AF]">
                      Checked inside <code className="font-mono">assertEligibleForMoney</code> before locking wallets in matchmaking or call-outs.
                    </p>
                  </div>

                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 space-y-1">
                    <div className="flex items-center justify-between font-bold text-[#F4F2ED]">
                      <span>Timeout &amp; Self-Exclusion (`timeoutUntil` / `selfExcludedUntil`)</span>
                      <Badge variant="gold">Hard Block</Badge>
                    </div>
                    <p className="text-[#9CA3AF]">
                      Blocks matchmaking queue entry, call-out creation/acceptance, and deposit intents across all sessions.
                    </p>
                  </div>

                  <div className="bg-[#1E2229] border border-[#2E333B] rounded-lg p-3.5 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="font-bold text-[#F4F2ED] flex items-center gap-1.5">
                        <UserCheck className="w-4 h-4 text-[#E7B24A]" />
                        <span>Active Player Restrictions Registry</span>
                      </div>
                      <p className="text-[11px] text-[#9CA3AF]">
                        {canReadRestrictions
                          ? `${restrictionsTotal} player profile(s) currently have active limits, timeouts, or exclusions.`
                          : 'Individual player restrictions are managed in Risk & Safer Play.'}
                      </p>
                    </div>
                    <Link href="/compliance/risk">
                      <Button variant="secondary" size="sm">
                        <Lock className="w-3.5 h-3.5" />
                        Open Risk &amp; Safer Play
                      </Button>
                    </Link>
                  </div>

                  {canReadRestrictions && activeRestrictions.length > 0 && (
                    <div className="text-[11px] text-[#6B7280] flex items-center gap-1.5 pt-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        Showing live connection to <code className="font-mono">/admin/safer-play/restrictions</code> ({activeRestrictions.length} recent profiles verified).
                      </span>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        );
      }}
    </DomainConfigWorkspace>
  );
}
