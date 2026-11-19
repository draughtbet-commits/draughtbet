'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import {
  formatNairaWithKobo,
  koboToNairaInput,
  nairaInputToKobo
} from '@/lib/config/diff';
import { PlayerTier } from '@/lib/api/types';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { formatNaira } from '@/lib/utils';
import {
  Coins,
  Percent,
  Layers,
  ShieldAlert,
  Lock,
  Receipt,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';

interface KoboMoneyFieldProps {
  label: string;
  pathKey: string;
  koboValue: string;
  activeKoboValue: string;
  disabled: boolean;
  allowZero?: boolean;
  inputMode: 'KOBO' | 'NAIRA';
  error?: string;
  onChangeKobo: (newKobo: string) => void;
}

function KoboMoneyField({
  label,
  pathKey,
  koboValue,
  activeKoboValue,
  disabled,
  allowZero = false,
  inputMode,
  error,
  onChangeKobo
}: KoboMoneyFieldProps) {
  const displayVal = inputMode === 'KOBO' ? koboValue : koboToNairaInput(koboValue);

  const handleChange = (raw: string) => {
    const cleaned = raw.trim();
    if (inputMode === 'KOBO') {
      const digitsOnly = cleaned.replace(/[^\d]/g, '');
      onChangeKobo(digitsOnly || (allowZero ? '0' : ''));
    } else {
      const converted = nairaInputToKobo(cleaned);
      if (converted !== null) {
        onChangeKobo(converted);
      } else if (cleaned === '') {
        onChangeKobo(allowZero ? '0' : '');
      }
    }
  };

  return (
    <div className="bg-[#000000] border border-[#274056] rounded-xl p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={`fin-${pathKey}`}
          className="text-xs font-semibold uppercase tracking-wider text-[#F5F7FA]"
        >
          {label}
        </label>
        <span className="font-mono text-xs font-bold text-[#18C986]">
          {formatNaira(koboValue || '0')}
        </span>
      </div>

      <div className="relative">
        <input
          id={`fin-${pathKey}`}
          type="text"
          inputMode="numeric"
          disabled={disabled}
          value={displayVal}
          onChange={(e) => handleChange(e.target.value)}
          className={`w-full h-9 px-3 pr-20 bg-[#0C1B2A] border rounded-lg font-mono text-xs text-[#F5F7FA] focus:outline-none focus:border-[#18C986] disabled:opacity-50 ${
            error ? 'border-rose-500' : 'border-[#274056]'
          }`}
        />
        <span className="absolute right-3 top-2 text-[10px] font-mono uppercase text-[#8FA3B7]">
          {inputMode === 'KOBO' ? 'kobo (minor)' : 'NGN (₦)'}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-[#8FA3B7]">
        <span className="font-mono">
          Canonical: <strong className="text-[#F5F7FA]">{koboValue || '0'}</strong> kobo (100 kobo = ₦1.00)
        </span>
        <span className="font-mono text-[#53677A]">
          Active: {formatNairaWithKobo(activeKoboValue)}
        </span>
      </div>

      {error && <p className="text-xs text-rose-400 font-medium">{error}</p>}
    </div>
  );
}

export default function FinancialConfigurationPage() {
  const [unitInputMode, setUnitInputMode] = useState<'KOBO' | 'NAIRA'>('KOBO');

  return (
    <DomainConfigWorkspace
      domains={['FINANCIAL', 'TIERS']}
      title="Financial Configuration, Rake & Tier Stake Bands"
      subtitle="Configure NGN deposit/withdrawal thresholds, platform commission rake percentage, and monotonic tier stake boundaries."
      impactNotice="MAKER-CHECKER REQUIRED: All changes in FINANCIAL and TIERS require independent reviewer approval. Active funded matches retain their frozen Match.settlementCommissionPercent and stakeMinorUnits."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        // BigInt co-dependent boundary checks (zero floating-point math)
        const safeBigInt = (v: string) => {
          try {
            return /^\d+$/.test(v) ? BigInt(v) : null;
          } catch {
            return null;
          }
        };

        const localBoundaryWarnings: string[] = [];
        const minDep = safeBigInt(draftPayload.financial.minDepositMinorUnits);
        const maxDep = safeBigInt(draftPayload.financial.maxDepositMinorUnits);
        if (minDep !== null && maxDep !== null && minDep > maxDep) {
          localBoundaryWarnings.push(
            'Minimum deposit (minDepositMinorUnits) cannot exceed maximum deposit (maxDepositMinorUnits).'
          );
        }

        const minWd = safeBigInt(draftPayload.financial.minWithdrawalMinorUnits);
        const maxWd = safeBigInt(draftPayload.financial.maxWithdrawalMinorUnits);
        if (minWd !== null && maxWd !== null && minWd > maxWd) {
          localBoundaryWarnings.push(
            'Minimum withdrawal (minWithdrawalMinorUnits) cannot exceed maximum withdrawal (maxWithdrawalMinorUnits).'
          );
        }

        const amMin = safeBigInt(draftPayload.tiers.AMATEUR.minStake);
        const amMax = safeBigInt(draftPayload.tiers.AMATEUR.maxStake);
        const maMin = safeBigInt(draftPayload.tiers.MASTER.minStake);
        const maMax = safeBigInt(draftPayload.tiers.MASTER.maxStake);
        const prMin = safeBigInt(draftPayload.tiers.PRO.minStake);
        const prMax = safeBigInt(draftPayload.tiers.PRO.maxStake);

        if (amMin !== null && amMax !== null && amMin >= amMax) {
          localBoundaryWarnings.push('AMATEUR minStake must be strictly less than AMATEUR maxStake.');
        }
        if (maMin !== null && maMax !== null && maMin >= maMax) {
          localBoundaryWarnings.push('MASTER minStake must be strictly less than MASTER maxStake.');
        }
        if (prMin !== null && prMax !== null && prMin >= prMax) {
          localBoundaryWarnings.push('PRO minStake must be strictly less than PRO maxStake.');
        }
        if (amMin !== null && maMin !== null && amMin > maMin) {
          localBoundaryWarnings.push('MASTER minStake must be >= AMATEUR minStake (monotonic tier progression).');
        }
        if (maMin !== null && prMin !== null && maMin > prMin) {
          localBoundaryWarnings.push('PRO minStake must be >= MASTER minStake (monotonic tier progression).');
        }
        if (amMax !== null && maMax !== null && amMax > maMax) {
          localBoundaryWarnings.push('MASTER maxStake must be >= AMATEUR maxStake (monotonic tier progression).');
        }
        if (maMax !== null && prMax !== null && maMax > prMax) {
          localBoundaryWarnings.push('PRO maxStake must be >= MASTER maxStake (monotonic tier progression).');
        }

        const tiersList: Array<{
          tier: PlayerTier;
          title: string;
          subtitle: string;
        }> = [
          {
            tier: 'AMATEUR',
            title: 'Amateur Tier (`tiers.AMATEUR`)',
            subtitle: 'Entry tier. Standard matchmaking presets; Call-out ceiling defaults to 0 kobo (not eligible).'
          },
          {
            tier: 'MASTER',
            title: 'Master Tier (`tiers.MASTER`)',
            subtitle: 'Intermediate tier. Higher matchmaking stake band and high-stakes call-out eligibility.'
          },
          {
            tier: 'PRO',
            title: 'Pro Tier (`tiers.PRO`)',
            subtitle: 'Premier tier. Highest normal matchmaking stake band and maximum call-out ceiling.'
          }
        ];

        return (
          <div className="space-y-6">
            {/* Unit Mode Switcher & Financial Invariant Guardrail Banner */}
            <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-start gap-3">
                <Lock className="w-5 h-5 text-[#18C986] shrink-0 mt-0.5" />
                <div className="text-xs space-y-0.5">
                  <div className="font-bold text-[#F5F7FA]">
                    BigInt Minor-Unit (Kobo) Precision &amp; Double-Entry Ledger Invariance
                  </div>
                  <p className="text-[#8FA3B7]">
                    All monetary configuration values are stored as exact integer strings in minor units (kobo, where{' '}
                    <code className="font-mono text-[#18C986]">100 kobo = ₦1.00</code>). Floating-point arithmetic is
                    never used. Configuration settings govern transaction thresholds and future match rake only — they
                    can never directly set wallet balances, mutate posted ledger entries, or alter settled match payouts.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 bg-[#000000] border border-[#274056] rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setUnitInputMode('KOBO')}
                  className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-colors ${
                    unitInputMode === 'KOBO'
                      ? 'bg-[#0E2E2B] text-[#18C986] border border-[#18C986]/40'
                      : 'text-[#8FA3B7] hover:text-[#F5F7FA]'
                  }`}
                >
                  Edit in Kobo (Canonical)
                </button>
                <button
                  type="button"
                  onClick={() => setUnitInputMode('NAIRA')}
                  className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-colors ${
                    unitInputMode === 'NAIRA'
                      ? 'bg-[#0E2E2B] text-[#18C986] border border-[#18C986]/40'
                      : 'text-[#8FA3B7] hover:text-[#F5F7FA]'
                  }`}
                >
                  Edit in Naira (₦)
                </button>
              </div>
            </div>

            {localBoundaryWarnings.length > 0 && (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-xs text-rose-300 space-y-1">
                <div className="flex items-center gap-2 font-bold text-rose-400">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Co-Dependent Financial Boundary Violation(s) Detected:</span>
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {localBoundaryWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Section 1: Platform Commission Rake & Deposit/Withdrawal Limits */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Rake Commission Card */}
              <Card className="space-y-4">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Percent className="w-5 h-5 text-[#18C986]" />
                    <div>
                      <CardTitle>Platform Commission Rake</CardTitle>
                      <CardDescription>Whole-percent fee deducted from decided match pots.</CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Restricted</Badge>
                </CardHeader>

                <Input
                  label="Commission Percentage (`financial.commissionPercent`)"
                  type="number"
                  min={1}
                  max={25}
                  disabled={!canEdit}
                  value={String(draftPayload.financial.commissionPercent)}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    updateDraftPayload((prev) => {
                      prev.financial.commissionPercent = Number.isNaN(parsed) ? 0 : parsed;
                      return prev;
                    });
                  }}
                  error={fieldErrors['financial.commissionPercent']}
                  helperText={`Current Active: ${activePayload.financial.commissionPercent}% • Allowed Range: 1% – 25% (Draws charge 0% commission)`}
                />

                <div className="bg-[#000000] border border-[#274056] rounded-lg p-3.5 text-xs space-y-1.5">
                  <div className="font-semibold text-[#F5F7FA]">Example Payout Preview (₦10,000 Stake / Player):</div>
                  <div className="flex justify-between text-[#8FA3B7]">
                    <span>Total Match Pot (2 × Stake):</span>
                    <span className="font-mono text-[#F5F7FA]">₦20,000.00 (2,000,000 kobo)</span>
                  </div>
                  <div className="flex justify-between text-[#8FA3B7]">
                    <span>Platform Commission ({draftPayload.financial.commissionPercent}%):</span>
                    <span className="font-mono text-[#18C986]">
                      {formatNaira(
                        (BigInt(2000000) * BigInt(Math.max(0, draftPayload.financial.commissionPercent))) /
                          BigInt(100)
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#8FA3B7] pt-1 border-t border-[#274056]">
                    <span>Winner Net Payout:</span>
                    <span className="font-mono text-emerald-400 font-bold">
                      {formatNaira(
                        BigInt(2000000) -
                          (BigInt(2000000) * BigInt(Math.max(0, draftPayload.financial.commissionPercent))) /
                            BigInt(100)
                      )}
                    </span>
                  </div>
                </div>
              </Card>

              {/* Deposit & Withdrawal Thresholds Card */}
              <Card className="lg:col-span-2 space-y-4">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Coins className="w-5 h-5 text-[#18C986]" />
                    <div>
                      <CardTitle>Deposit &amp; Withdrawal Transaction Thresholds (NGN)</CardTitle>
                      <CardDescription>
                        Server-enforced per-transaction and daily aggregate bounds in canonical minor units (kobo).
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Maker-Checker</Badge>
                </CardHeader>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <KoboMoneyField
                    label="Minimum Deposit (`minDepositMinorUnits`)"
                    pathKey="financial.minDepositMinorUnits"
                    koboValue={draftPayload.financial.minDepositMinorUnits}
                    activeKoboValue={activePayload.financial.minDepositMinorUnits}
                    disabled={!canEdit}
                    inputMode={unitInputMode}
                    error={fieldErrors['financial.minDepositMinorUnits']}
                    onChangeKobo={(val) =>
                      updateDraftPayload((prev) => {
                        prev.financial.minDepositMinorUnits = val;
                        return prev;
                      })
                    }
                  />

                  <KoboMoneyField
                    label="Maximum Deposit (`maxDepositMinorUnits`)"
                    pathKey="financial.maxDepositMinorUnits"
                    koboValue={draftPayload.financial.maxDepositMinorUnits}
                    activeKoboValue={activePayload.financial.maxDepositMinorUnits}
                    disabled={!canEdit}
                    inputMode={unitInputMode}
                    error={fieldErrors['financial.maxDepositMinorUnits']}
                    onChangeKobo={(val) =>
                      updateDraftPayload((prev) => {
                        prev.financial.maxDepositMinorUnits = val;
                        return prev;
                      })
                    }
                  />

                  <KoboMoneyField
                    label="Minimum Withdrawal (`minWithdrawalMinorUnits`)"
                    pathKey="financial.minWithdrawalMinorUnits"
                    koboValue={draftPayload.financial.minWithdrawalMinorUnits}
                    activeKoboValue={activePayload.financial.minWithdrawalMinorUnits}
                    disabled={!canEdit}
                    inputMode={unitInputMode}
                    error={fieldErrors['financial.minWithdrawalMinorUnits']}
                    onChangeKobo={(val) =>
                      updateDraftPayload((prev) => {
                        prev.financial.minWithdrawalMinorUnits = val;
                        return prev;
                      })
                    }
                  />

                  <KoboMoneyField
                    label="Maximum Withdrawal (`maxWithdrawalMinorUnits`)"
                    pathKey="financial.maxWithdrawalMinorUnits"
                    koboValue={draftPayload.financial.maxWithdrawalMinorUnits}
                    activeKoboValue={activePayload.financial.maxWithdrawalMinorUnits}
                    disabled={!canEdit}
                    inputMode={unitInputMode}
                    error={fieldErrors['financial.maxWithdrawalMinorUnits']}
                    onChangeKobo={(val) =>
                      updateDraftPayload((prev) => {
                        prev.financial.maxWithdrawalMinorUnits = val;
                        return prev;
                      })
                    }
                  />

                  <div className="md:col-span-2">
                    <KoboMoneyField
                      label="Daily Aggregate Withdrawal Ceiling (`dailyWithdrawalCeilingMinorUnits`)"
                      pathKey="financial.dailyWithdrawalCeilingMinorUnits"
                      koboValue={draftPayload.financial.dailyWithdrawalCeilingMinorUnits}
                      activeKoboValue={activePayload.financial.dailyWithdrawalCeilingMinorUnits}
                      disabled={!canEdit}
                      inputMode={unitInputMode}
                      error={fieldErrors['financial.dailyWithdrawalCeilingMinorUnits']}
                      onChangeKobo={(val) =>
                        updateDraftPayload((prev) => {
                          prev.financial.dailyWithdrawalCeilingMinorUnits = val;
                          return prev;
                        })
                      }
                    />
                  </div>
                </div>
              </Card>
            </div>

            {/* Section 2: Tier Stake & Call-Out Ceilings */}
            <Card className="space-y-5">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <Layers className="w-5 h-5 text-[#18C986]" />
                  <div>
                    <CardTitle>Player Tier Stake Boundaries &amp; Call-Out Ceilings (`tiers`)</CardTitle>
                    <CardDescription>
                      Monotonic stake progression across Amateur, Master, and Pro tiers. Call-out ceilings are validated separately from normal matchmaking presets.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="gold">Monotonic Progression Enforced</Badge>
              </CardHeader>

              <div className="space-y-6">
                {tiersList.map(({ tier, title, subtitle }) => (
                  <div
                    key={tier}
                    className="bg-[#132638]/60 border border-[#274056] rounded-xl p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-bold text-[#F5F7FA]">{title}</h4>
                        <p className="text-xs text-[#8FA3B7]">{subtitle}</p>
                      </div>
                      <Badge variant="default">{tier}</Badge>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <KoboMoneyField
                        label={`${tier} Min Stake`}
                        pathKey={`tiers.${tier}.minStake`}
                        koboValue={draftPayload.tiers[tier].minStake}
                        activeKoboValue={activePayload.tiers[tier].minStake}
                        disabled={!canEdit}
                        inputMode={unitInputMode}
                        error={fieldErrors[`tiers.${tier}.minStake`]}
                        onChangeKobo={(val) =>
                          updateDraftPayload((prev) => {
                            prev.tiers[tier].minStake = val;
                            return prev;
                          })
                        }
                      />

                      <KoboMoneyField
                        label={`${tier} Max Stake`}
                        pathKey={`tiers.${tier}.maxStake`}
                        koboValue={draftPayload.tiers[tier].maxStake}
                        activeKoboValue={activePayload.tiers[tier].maxStake}
                        disabled={!canEdit}
                        inputMode={unitInputMode}
                        error={fieldErrors[`tiers.${tier}.maxStake`]}
                        onChangeKobo={(val) =>
                          updateDraftPayload((prev) => {
                            prev.tiers[tier].maxStake = val;
                            return prev;
                          })
                        }
                      />

                      <KoboMoneyField
                        label={`${tier} Call-Out Max`}
                        pathKey={`tiers.${tier}.maxCallout`}
                        koboValue={draftPayload.tiers[tier].maxCallout}
                        activeKoboValue={activePayload.tiers[tier].maxCallout}
                        disabled={!canEdit}
                        allowZero={true}
                        inputMode={unitInputMode}
                        error={fieldErrors[`tiers.${tier}.maxCallout`]}
                        onChangeKobo={(val) =>
                          updateDraftPayload((prev) => {
                            prev.tiers[tier].maxCallout = val;
                            return prev;
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Payment Gateways & Financial Governance Links */}
            <Card className="space-y-4">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <ShieldAlert className="w-5 h-5 text-emerald-400" />
                  <div>
                    <CardTitle>Payment Providers &amp; Financial Ledger Separation</CardTitle>
                    <CardDescription>
                      Phase 1 NGN payment gateways (Paystack primary, Flutterwave secondary) and double-entry ledger boundaries.
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link href="/finance/ledger">
                    <Button variant="outline" size="sm">
                      <Receipt className="w-3.5 h-3.5" />
                      Ledger Explorer
                    </Button>
                  </Link>
                  <Link href="/finance/withdrawals">
                    <Button variant="outline" size="sm">
                      Withdrawal Queue
                    </Button>
                  </Link>
                </div>
              </CardHeader>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="bg-[#000000] border border-[#274056] rounded-lg p-4 space-y-1">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Gateway Secrets &amp; Webhook Verification</span>
                  </div>
                  <p className="text-[#8FA3B7]">
                    Paystack (<code className="font-mono">x-paystack-signature</code> HMAC-SHA512) and Flutterwave (
                    <code className="font-mono">verif-hash</code>) secrets remain strictly in server environment stores
                    and are never exposed in configuration payloads or browser responses. Operational withdrawal
                    kill-switches are managed under <Link href="/configuration/feature-flags" className="text-[#18C986] hover:underline">Feature Flags</Link>.
                  </p>
                </div>

                <div className="bg-[#000000] border border-[#274056] rounded-lg p-4 space-y-1">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <Lock className="w-4 h-4 text-[#18C986]" />
                    <span>PlatformSettings Singleton Synchronization</span>
                  </div>
                  <p className="text-[#8FA3B7]">
                    When an approved configuration version is atomically activated, the backend updates both{' '}
                    <code className="font-mono">PlatformConfigVersion</code> and the legacy{' '}
                    <code className="font-mono">PlatformSettings</code> singleton inside the same ACID PostgreSQL
                    transaction.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        );
      }}
    </DomainConfigWorkspace>
  );
}
