'use client';

import React from 'react';
import Link from 'next/link';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { formatNaira } from '@/lib/utils';
import { UsersRound, Clock, Layers, Cpu, Flag, Coins } from 'lucide-react';

const DISCRETE_STAKE_PRESETS: Record<'AMATEUR' | 'MASTER' | 'PRO', string[]> = {
  AMATEUR: ['50000', '100000', '500000'],
  MASTER: ['1000000', '1500000', '3000000'],
  PRO: ['3000000', '5000000', '6000000']
};

export default function MatchmakingConfigurationPage() {
  return (
    <DomainConfigWorkspace
      domains={['MATCHMAKING']}
      title="Matchmaking Queue & Pairing Worker Configuration"
      subtitle="Manage Redis queue expiration timeouts, worker pairing sweep intervals, and single-match concurrency rules."
      impactNotice="Changes to MATCHMAKING parameters apply to queue sweeps upon version activation. Discrete stake buckets and tier bounds are validated by tierEnforcement.js."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        const setIntField = (
          key: keyof typeof draftPayload.matchmaking,
          rawVal: string
        ) => {
          const parsed = Number.parseInt(rawVal, 10);
          updateDraftPayload((prev) => {
            prev.matchmaking[key] = Number.isNaN(parsed) ? 0 : parsed;
            return prev;
          });
        };

        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card 1: Queue & Worker Parameters */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Clock className="w-5 h-5 text-[#E7B24A]" />
                    <div>
                      <CardTitle>Queue Timeout &amp; Worker Sweep Settings (`matchmaking`)</CardTitle>
                      <CardDescription>
                        Controls Redis sorted-set queue retention and <code className="font-mono">matchmakingWorker.js</code> cron tick interval.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="info">Operational Domain</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <Input
                    label="Queue Expiration Timeout Seconds (`matchmaking.queueTimeoutSeconds`)"
                    type="number"
                    min={30}
                    max={600}
                    disabled={!canEdit}
                    value={String(draftPayload.matchmaking.queueTimeoutSeconds)}
                    onChange={(e) => setIntField('queueTimeoutSeconds', e.target.value)}
                    error={fieldErrors['matchmaking.queueTimeoutSeconds']}
                    helperText={`Current Active: ${activePayload.matchmaking.queueTimeoutSeconds}s • Constraint: 30s – 600s before unpaired queue entry expires`}
                  />

                  <Input
                    label="Worker Pairing Sweep Interval Seconds (`matchmaking.cronTickSeconds`)"
                    type="number"
                    min={1}
                    max={15}
                    disabled={!canEdit}
                    value={String(draftPayload.matchmaking.cronTickSeconds)}
                    onChange={(e) => setIntField('cronTickSeconds', e.target.value)}
                    error={fieldErrors['matchmaking.cronTickSeconds']}
                    helperText={`Current Active: ${activePayload.matchmaking.cronTickSeconds}s • Constraint: 1s – 15s between atomic Lua popMatchmakingPair sweeps`}
                  />

                  <Input
                    label="Max Concurrent Queue Entries Per Player (`matchmaking.maxConcurrentQueuePerPlayer`)"
                    type="number"
                    min={1}
                    max={1}
                    disabled={true}
                    value={String(draftPayload.matchmaking.maxConcurrentQueuePerPlayer)}
                    helperText="Locked to 1 (`z.number().int().min(1).max(1)`): enforces the single-game-at-a-time platform invariant (`hasPreterminalMatchForPlayers`)."
                  />
                </div>
              </Card>

              {/* Card 2: Pairing Architecture & Operational Controls */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Cpu className="w-5 h-5 text-[#E7B24A]" />
                    <div>
                      <CardTitle>Pairing Architecture &amp; Kill-Switch Linkage</CardTitle>
                      <CardDescription>
                        How REST queue entry, Lua CAS popping, and atomic stake funding interact.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Atomic Lua CAS</Badge>
                </CardHeader>

                <div className="space-y-3 text-xs">
                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 space-y-1">
                    <div className="font-bold text-[#F4F2ED]">
                      1. Exact Tier &amp; Stake Bucket Pairing (`queue:{'{tier}'}:{'{stakeMinorUnits}'}`)
                    </div>
                    <p className="text-[#9CA3AF]">
                      Players join via <code className="font-mono">POST /api/v1/matchmaking/join</code> and are placed
                      into a Redis sorted set keyed by exact tier and stake bucket, scored by join timestamp (FIFO).
                      Cross-tier or variable-stake tolerance matching is deliberately disabled in Phase 1 so players
                      never wager an unexpected stake.
                    </p>
                  </div>

                  <div className="bg-[#0B0D10] border border-[#2E333B] rounded-lg p-3.5 space-y-1">
                    <div className="flex items-center justify-between font-bold text-[#F4F2ED]">
                      <span>2. Pre-Terminal Match Choke Point</span>
                      <Badge variant="success">Enforced</Badge>
                    </div>
                    <p className="text-[#9CA3AF]">
                      Both queue join and <code className="font-mono">createMatchWithStakes</code> check{' '}
                      <code className="font-mono">hasPreterminalMatchForPlayers</code> under ordered wallet row locks (
                      <code className="font-mono">SELECT ... FOR UPDATE</code>) so a player can never be double-paired.
                    </p>
                  </div>

                  <div className="bg-[#1E2229] border border-[#2E333B] rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-bold text-[#F4F2ED]">Emergency Queue Pause</div>
                      <p className="text-[11px] text-[#9CA3AF]">
                        Use the <code className="font-mono">live_matchmaking_queue</code> kill-switch or{' '}
                        <code className="font-mono">MATCHMAKING_ONLY</code> maintenance scope to pause new pairings.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link href="/configuration/feature-flags">
                        <Button variant="secondary" size="sm">
                          <Flag className="w-3.5 h-3.5" />
                          Kill Switches
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {/* Discrete Stake Buckets & Tier Boundaries Reference */}
            <Card className="space-y-4">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <Layers className="w-5 h-5 text-[#E7B24A]" />
                  <div>
                    <CardTitle>Active Tier Stake Bounds &amp; Discrete Matchmaking Buckets</CardTitle>
                    <CardDescription>
                      Option A discrete matchmaking presets (<code className="font-mono">tierEnforcement.js</code>) validated against active <code className="font-mono">tiers</code> min/max boundaries.
                    </CardDescription>
                  </div>
                </div>
                <Link href="/configuration/financial">
                  <Button variant="outline" size="sm">
                    <Coins className="w-3.5 h-3.5" />
                    Edit Tier Bounds in Financial Config
                  </Button>
                </Link>
              </CardHeader>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(['AMATEUR', 'MASTER', 'PRO'] as const).map((tier) => {
                  const tierCfg = activePayload.tiers[tier];
                  const presets = DISCRETE_STAKE_PRESETS[tier];
                  return (
                    <div
                      key={tier}
                      className="bg-[#0B0D10] border border-[#2E333B] rounded-xl p-4 space-y-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[#F4F2ED] flex items-center gap-1.5">
                          <UsersRound className="w-4 h-4 text-[#E7B24A]" />
                          {tier} Tier
                        </span>
                        <Badge variant="default">
                          {formatNaira(tierCfg.minStake)} – {formatNaira(tierCfg.maxStake)}
                        </Badge>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[11px] text-[#9CA3AF]">Matchmaking Stake Buckets:</span>
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {presets.map((kobo) => (
                            <span
                              key={kobo}
                              className="px-2 py-1 rounded bg-[#15181D] border border-[#2E333B] font-mono text-[11px] text-[#E7B24A]"
                            >
                              {formatNaira(kobo)}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[#2E333B] flex justify-between text-[11px] text-[#9CA3AF]">
                        <span>Direct Call-Out Ceiling:</span>
                        <span className="font-mono text-[#F4F2ED]">
                          {tierCfg.maxCallout === '0'
                            ? 'Not Eligible (₦0.00)'
                            : formatNaira(tierCfg.maxCallout)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        );
      }}
    </DomainConfigWorkspace>
  );
}
