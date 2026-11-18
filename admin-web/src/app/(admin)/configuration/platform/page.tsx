'use client';

import React, { useState } from 'react';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Globe, Mail, Coins, Server, Info, Plus, X } from 'lucide-react';

export default function PlatformSettingsPage() {
  const [newCurrencyInput, setNewCurrencyInput] = useState('');

  return (
    <DomainConfigWorkspace
      domains={['PLATFORM']}
      title="Platform Settings & Identity"
      subtitle="Configure brand identity, canonical NGN currency defaults, operational support routing, and environment metadata."
      impactNotice="Changes in the PLATFORM domain take effect globally upon version activation. Default currency is locked to NGN (Nigeria Phase 1 MVP)."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        const handleAddCurrency = () => {
          const code = newCurrencyInput.trim().toUpperCase();
          if (code.length !== 3 || !/^[A-Z]{3}$/.test(code)) return;
          if (draftPayload.platform.supportedCurrencies.includes(code)) {
            setNewCurrencyInput('');
            return;
          }
          updateDraftPayload((prev) => {
            prev.platform.supportedCurrencies = [...prev.platform.supportedCurrencies, code];
            return prev;
          });
          setNewCurrencyInput('');
        };

        const handleRemoveCurrency = (code: string) => {
          if (code === 'NGN' || draftPayload.platform.supportedCurrencies.length <= 1) return;
          updateDraftPayload((prev) => {
            prev.platform.supportedCurrencies = prev.platform.supportedCurrencies.filter(
              (c) => c !== code
            );
            return prev;
          });
        };

        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Section 1: Identity & Support Contact */}
            <Card className="space-y-5">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <Globe className="w-5 h-5 text-[#E7B24A]" />
                  <div>
                    <CardTitle>Platform Identity &amp; Support Routing</CardTitle>
                    <CardDescription>
                      Canonical display identity and player support contact address.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="info">Operational Domain</Badge>
              </CardHeader>

              <div className="space-y-4">
                <div>
                  <Input
                    label="Platform Identity (`platform.identity`)"
                    value={draftPayload.platform.identity}
                    disabled={!canEdit}
                    onChange={(e) =>
                      updateDraftPayload((prev) => {
                        prev.platform.identity = e.target.value;
                        return prev;
                      })
                    }
                    error={fieldErrors['platform.identity']}
                    helperText={`Current Active: "${activePayload.platform.identity}" • Constraint: 1–100 characters`}
                  />
                </div>

                <div>
                  <Input
                    label="Operational Support Email (`platform.supportEmail`)"
                    type="email"
                    value={draftPayload.platform.supportEmail}
                    disabled={!canEdit}
                    onChange={(e) =>
                      updateDraftPayload((prev) => {
                        prev.platform.supportEmail = e.target.value;
                        return prev;
                      })
                    }
                    error={fieldErrors['platform.supportEmail']}
                    helperText={`Current Active: ${activePayload.platform.supportEmail} • Must be a valid email address`}
                  />
                </div>

                <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 text-xs text-[#9CA3AF] flex items-start gap-2.5">
                  <Mail className="w-4 h-4 text-[#E7B24A] shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-[#F4F2ED]">Operational Scope: </span>
                    Updating <code className="font-mono">platform.identity</code> or{' '}
                    <code className="font-mono">platform.supportEmail</code> affects support metadata and system
                    headers for future requests without altering active match or wallet records.
                  </div>
                </div>
              </div>
            </Card>

            {/* Section 2: Currency & Regional Monetary Configuration */}
            <Card className="space-y-5">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <Coins className="w-5 h-5 text-[#E7B24A]" />
                  <div>
                    <CardTitle>Currency &amp; Monetary Registry</CardTitle>
                    <CardDescription>
                      Phase 1 NGN minor-unit (kobo) settlement standard and supported ISO-4217 codes.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="gold">NGN Canonical</Badge>
              </CardHeader>

              <div className="space-y-4">
                <div>
                  <Input
                    label="Default Settlement Currency (`platform.defaultCurrency`)"
                    value={draftPayload.platform.defaultCurrency}
                    disabled={true}
                    helperText="Locked to NGN per backend schema literal (`z.literal('NGN')`). All ledger entries are recorded in integer kobo."
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                    Supported Currencies (`platform.supportedCurrencies`)
                  </label>
                  <div className="flex flex-wrap items-center gap-2 bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3">
                    {draftPayload.platform.supportedCurrencies.map((code) => (
                      <span
                        key={code}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#1E2229] border border-[#2E333B] font-mono text-xs text-[#F4F2ED]"
                      >
                        {code}
                        {canEdit && code !== 'NGN' && draftPayload.platform.supportedCurrencies.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveCurrency(code)}
                            className="text-[#9CA3AF] hover:text-rose-400"
                            aria-label={`Remove currency ${code}`}
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
                        maxLength={3}
                        placeholder="Add 3-letter ISO code (e.g. GBP)"
                        value={newCurrencyInput}
                        onChange={(e) => setNewCurrencyInput(e.target.value.toUpperCase())}
                        className="h-9 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg text-xs font-mono text-[#F4F2ED] placeholder-[#6B7280] focus:outline-none focus:border-[#E7B24A]"
                      />
                      <Button variant="secondary" size="sm" type="button" onClick={handleAddCurrency}>
                        <Plus className="w-3.5 h-3.5" />
                        Add Code
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-[#6B7280]">
                    Current Active: {activePayload.platform.supportedCurrencies.join(', ')} • Constraint: 3-letter ISO-4217 codes (NGN mandatory).
                  </p>
                </div>
              </div>
            </Card>

            {/* Section 3: Schema & Environment Metadata */}
            <Card className="lg:col-span-2 space-y-4">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <Server className="w-5 h-5 text-[#E7B24A]" />
                  <div>
                    <CardTitle>Schema &amp; Environment Profile (`meta`)</CardTitle>
                    <CardDescription>
                      Canonical configuration schema version and deployment target classification.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="default">Schema v{draftPayload.meta.schemaVersion}</Badge>
              </CardHeader>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="meta-environment-select"
                    className="block text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]"
                  >
                    Deployment Environment (`meta.environment`)
                  </label>
                  <select
                    id="meta-environment-select"
                    disabled={!canEdit}
                    value={draftPayload.meta.environment}
                    onChange={(e) =>
                      updateDraftPayload((prev) => {
                        prev.meta.environment = e.target.value as
                          | 'development'
                          | 'test'
                          | 'staging'
                          | 'production';
                        return prev;
                      })
                    }
                    className="w-full h-10 px-3 bg-[#15181D] border border-[#2E333B] rounded-lg text-sm text-[#F4F2ED] focus:outline-none focus:border-[#E7B24A] disabled:opacity-50"
                  >
                    <option value="production">production</option>
                    <option value="staging">staging</option>
                    <option value="development">development</option>
                    <option value="test">test</option>
                  </select>
                  <p className="text-xs text-[#6B7280]">
                    Current Active: <span className="font-mono">{activePayload.meta.environment}</span>
                  </p>
                </div>

                <div>
                  <Input
                    label="Canonical Schema Version (`meta.schemaVersion`)"
                    type="number"
                    value={String(draftPayload.meta.schemaVersion)}
                    disabled={true}
                    helperText="Authoritative RFC 8785 JCS schema version (v1)."
                  />
                </div>
              </div>

              <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 text-xs text-[#9CA3AF] flex items-start gap-2.5">
                <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-[#F4F2ED]">Approval &amp; Activation Policy: </span>
                  Standalone changes in the <code className="font-mono">PLATFORM</code> domain are classified as
                  non-restricted operational updates, but still follow the immutable version lifecycle (
                  <code className="font-mono">DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE</code>) with full
                  SHA-256 checksum binding and transactional outbox cache invalidation.
                </div>
              </div>
            </Card>
          </div>
        );
      }}
    </DomainConfigWorkspace>
  );
}
