'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import {
  formatNairaWithKobo,
  koboToNairaInput,
  nairaInputToKobo
} from '@/lib/config/diff';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatNaira } from '@/lib/utils';
import {
  ShieldCheck,
  Globe2,
  Lock,
  Plus,
  X,
  FileLock2,
  CheckCircle2
} from 'lucide-react';

export default function KycEligibilityConfigurationPage() {
  const [unitInputMode, setUnitInputMode] = useState<'KOBO' | 'NAIRA'>('KOBO');
  const [countryInput, setCountryInput] = useState('');

  return (
    <DomainConfigWorkspace
      domains={['KYC']}
      title="KYC & Regional Eligibility Policy"
      subtitle="Manage mandatory withdrawal verification thresholds, high-stakes call-out KYC gates, and permitted ISO-3166-1 alpha-2 jurisdictions."
      impactNotice="MAKER-CHECKER REQUIRED: Changes to KYC and regional eligibility require independent reviewer approval. Private KYC identity documents are never exposed in configuration views."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        const thresholdKobo = draftPayload.kyc.mandatoryWithdrawalThresholdMinorUnits;
        const displayThreshold =
          unitInputMode === 'KOBO' ? thresholdKobo : koboToNairaInput(thresholdKobo);

        const handleThresholdChange = (raw: string) => {
          const cleaned = raw.trim();
          if (unitInputMode === 'KOBO') {
            const digits = cleaned.replace(/[^\d]/g, '');
            updateDraftPayload((prev) => {
              prev.kyc.mandatoryWithdrawalThresholdMinorUnits = digits || '0';
              return prev;
            });
          } else {
            const kobo = nairaInputToKobo(cleaned);
            if (kobo !== null) {
              updateDraftPayload((prev) => {
                prev.kyc.mandatoryWithdrawalThresholdMinorUnits = kobo;
                return prev;
              });
            }
          }
        };

        const handleAddCountry = () => {
          const code = countryInput.trim().toUpperCase();
          if (!/^[A-Z]{2}$/.test(code)) return;
          if (draftPayload.kyc.allowedCountries.includes(code)) {
            setCountryInput('');
            return;
          }
          updateDraftPayload((prev) => {
            prev.kyc.allowedCountries = [...prev.kyc.allowedCountries, code];
            return prev;
          });
          setCountryInput('');
        };

        const handleRemoveCountry = (code: string) => {
          if (draftPayload.kyc.allowedCountries.length <= 1) return;
          updateDraftPayload((prev) => {
            prev.kyc.allowedCountries = prev.kyc.allowedCountries.filter((c) => c !== code);
            return prev;
          });
        };

        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card 1: Verification Thresholds & Feature Gates */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <ShieldCheck className="w-5 h-5 text-[#E7B24A]" />
                    <div>
                      <CardTitle>Verification Thresholds &amp; Feature Gates</CardTitle>
                      <CardDescription>
                        Progressive KYC triggers for withdrawals and high-stakes call-out challenges.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Restricted (Maker-Checker)</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                      Threshold Input Unit
                    </span>
                    <div className="inline-flex bg-[#0B0D10] border border-[#2E333B] rounded-lg p-0.5 text-xs font-mono">
                      <button
                        type="button"
                        onClick={() => setUnitInputMode('KOBO')}
                        className={`px-2.5 py-1 rounded ${
                          unitInputMode === 'KOBO'
                            ? 'bg-[#3A2E17] text-[#E7B24A]'
                            : 'text-[#9CA3AF]'
                        }`}
                      >
                        Kobo
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnitInputMode('NAIRA')}
                        className={`px-2.5 py-1 rounded ${
                          unitInputMode === 'NAIRA'
                            ? 'bg-[#3A2E17] text-[#E7B24A]'
                            : 'text-[#9CA3AF]'
                        }`}
                      >
                        Naira (₦)
                      </button>
                    </div>
                  </div>

                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="kyc-withdrawal-threshold"
                        className="text-xs font-semibold uppercase tracking-wider text-[#F4F2ED]"
                      >
                        Mandatory Withdrawal KYC Threshold (`mandatoryWithdrawalThresholdMinorUnits`)
                      </label>
                      <span className="font-mono text-xs font-bold text-[#E7B24A]">
                        {formatNaira(thresholdKobo)}
                      </span>
                    </div>

                    <input
                      id="kyc-withdrawal-threshold"
                      type="text"
                      inputMode="numeric"
                      disabled={!canEdit}
                      value={displayThreshold}
                      onChange={(e) => handleThresholdChange(e.target.value)}
                      className="w-full h-10 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg font-mono text-sm text-[#F4F2ED] focus:outline-none focus:border-[#E7B24A] disabled:opacity-50"
                    />

                    <div className="flex flex-wrap justify-between text-[11px] text-[#9CA3AF]">
                      <span className="font-mono">Canonical: {thresholdKobo} kobo</span>
                      <span className="font-mono">
                        Active: {formatNairaWithKobo(activePayload.kyc.mandatoryWithdrawalThresholdMinorUnits)}
                      </span>
                    </div>
                    {fieldErrors['kyc.mandatoryWithdrawalThresholdMinorUnits'] && (
                      <p className="text-xs text-rose-400">
                        {fieldErrors['kyc.mandatoryWithdrawalThresholdMinorUnits']}
                      </p>
                    )}
                  </div>

                  {/* Toggle: Require Verification for Callouts */}
                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-[#F4F2ED]">
                        Require Verified KYC for High-Stakes Call-Outs (`kyc.requireVerificationForCallouts`)
                      </div>
                      <p className="text-xs text-[#9CA3AF]">
                        When enabled, players must hold <code className="font-mono">VERIFIED</code> KYC status before creating or accepting direct call-out challenges.
                      </p>
                      <p className="text-[11px] font-mono text-[#6B7280]">
                        Current Active: {activePayload.kyc.requireVerificationForCallouts ? 'Enabled (true)' : 'Disabled (false)'}
                      </p>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={draftPayload.kyc.requireVerificationForCallouts}
                      disabled={!canEdit}
                      onClick={() =>
                        updateDraftPayload((prev) => {
                          prev.kyc.requireVerificationForCallouts = !prev.kyc.requireVerificationForCallouts;
                          return prev;
                        })
                      }
                      className={`px-3.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider border transition-colors shrink-0 ${
                        draftPayload.kyc.requireVerificationForCallouts
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
                          : 'bg-[#1E2229] text-[#9CA3AF] border-[#2E333B]'
                      } disabled:opacity-50`}
                    >
                      {draftPayload.kyc.requireVerificationForCallouts ? 'Required' : 'Not Required'}
                    </button>
                  </div>
                </div>
              </Card>

              {/* Card 2: Allowed Jurisdictions & Account Eligibility */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Globe2 className="w-5 h-5 text-[#E7B24A]" />
                    <div>
                      <CardTitle>Regional &amp; Account Eligibility (`allowedCountries`)</CardTitle>
                      <CardDescription>
                        Permitted ISO-3166-1 alpha-2 country codes for real-money registration and play.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Geo-Eligibility</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                      Allowed Country Codes (`kyc.allowedCountries`)
                    </label>
                    <div className="flex flex-wrap items-center gap-2 bg-[#0B0D10] border border-[#2E333B] rounded-xl p-3.5 min-h-[52px]">
                      {draftPayload.kyc.allowedCountries.map((code) => (
                        <span
                          key={code}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#1E2229] border border-[#2E333B] font-mono text-xs text-[#F4F2ED]"
                        >
                          {code}
                          {canEdit && draftPayload.kyc.allowedCountries.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveCountry(code)}
                              className="text-[#9CA3AF] hover:text-rose-400"
                              aria-label={`Remove country ${code}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>

                    {canEdit && (
                      <div className="flex items-center gap-2 pt-1">
                        <input
                          type="text"
                          maxLength={2}
                          placeholder="2-letter ISO code (e.g. NG, GB)"
                          value={countryInput}
                          onChange={(e) => setCountryInput(e.target.value.toUpperCase())}
                          className="h-9 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs font-mono text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-[#E7B24A]"
                        />
                        <Button variant="secondary" size="sm" type="button" onClick={handleAddCountry}>
                          <Plus className="w-3.5 h-3.5" />
                          Add Jurisdiction
                        </Button>
                      </div>
                    )}

                    <p className="text-xs text-[#6B7280]">
                      Current Active: <span className="font-mono text-[#F4F2ED]">{activePayload.kyc.allowedCountries.join(', ')}</span> • Minimum 1 country code required.
                    </p>
                    {fieldErrors['kyc.allowedCountries'] && (
                      <p className="text-xs text-rose-400">{fieldErrors['kyc.allowedCountries']}</p>
                    )}
                  </div>

                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2 text-xs">
                    <div className="flex items-center gap-2 font-bold text-[#F4F2ED]">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>Hardcoded Server Eligibility Invariants (`eligibilityService.js`)</span>
                    </div>
                    <ul className="list-disc list-inside text-[#9CA3AF] space-y-1">
                      <li>
                        <strong>18+ Age Verification:</strong> Enforced at registration from claimed <code className="font-mono">dateOfBirth</code> and verified before any money operation (<code className="font-mono">assertEligibleForMoney</code>). Cannot be disabled via configuration.
                      </li>
                      <li>
                        <strong>Withdrawal KYC Gate:</strong> Enforced by <code className="font-mono">enforce_kyc_on_withdrawal</code> protected invariant flag and <code className="font-mono">WithdrawalService</code> before funds leave the platform.
                      </li>
                    </ul>
                  </div>
                </div>
              </Card>
            </div>

            {/* Privacy & Compliance Notice Card */}
            <Card className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-start gap-3">
                <FileLock2 className="w-5 h-5 text-[#E7B24A] shrink-0 mt-0.5" />
                <div className="text-xs space-y-0.5">
                  <div className="font-bold text-[#F4F2ED]">
                    Document Privacy &amp; Least-Privilege Separation
                  </div>
                  <p className="text-[#9CA3AF]">
                    This module manages policy thresholds only. Individual KYC verification cases and short-lived,
                    audited document access tokens are restricted to authorized <code className="font-mono">RISK_COMPLIANCE</code>{' '}
                    reviewers in the KYC Review Queue.
                  </p>
                </div>
              </div>
              <Link href="/compliance/kyc" className="shrink-0">
                <Button variant="outline" size="sm">
                  <Lock className="w-3.5 h-3.5" />
                  Open KYC Review Queue
                </Button>
              </Link>
            </Card>
          </div>
        );
      }}
    </DomainConfigWorkspace>
  );
}
