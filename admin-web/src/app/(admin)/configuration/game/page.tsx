'use client';

import React from 'react';
import Link from 'next/link';
import { DomainConfigWorkspace } from '@/components/configuration/DomainConfigWorkspace';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Gamepad2, Clock, Scale, ShieldCheck, Lock, Swords } from 'lucide-react';

export default function GameConfigurationPage() {
  return (
    <DomainConfigWorkspace
      domains={['GAME']}
      title="Game Configuration & Ruleset Parameters"
      subtitle="Manage International Draughts (10×10 / 50-square) engine defaults, per-turn clocks, disconnect grace windows, and draw thresholds."
      impactNotice="CRITICAL INVARIANT: Changes to game parameters apply ONLY to newly funded matches. Already-funded matches retain their frozen Match snapshot (timeControlSeconds, rulesetVersion, configurationVersion)."
    >
      {({ activePayload, draftPayload, updateDraftPayload, canEdit, fieldErrors }) => {
        const setIntField = (
          key: keyof typeof draftPayload.game,
          rawVal: string
        ) => {
          const parsed = Number.parseInt(rawVal, 10);
          updateDraftPayload((prev) => {
            prev.game[key] = Number.isNaN(parsed) ? 0 : parsed;
            return prev;
          });
        };

        return (
          <div className="space-y-6">
            {/* 3-Layer Architectural Distinction Banner */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#18C986]">
                    1. Ruleset Configuration
                  </span>
                  <Badge variant="gold">v{draftPayload.game.rulesetVersion}</Badge>
                </div>
                <p className="text-xs text-[#8FA3B7]">
                  Server-authoritative International Draughts (10×10 board, standard 1–50 notation, mandatory maximum capture, flying kings). Never delegated to client UI.
                </p>
              </div>

              <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
                    2. Platform-Wide Game Defaults
                  </span>
                  <Badge variant="info">Future Matches</Badge>
                </div>
                <p className="text-xs text-[#8FA3B7]">
                  Default turn clocks, readiness timers, disconnect grace windows, and draw thresholds applied when new matches are funded.
                </p>
              </div>

              <div className="bg-[#0C1B2A] border border-emerald-500/30 rounded-xl p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                    3. Frozen Match Snapshots
                  </span>
                  <Badge variant="success">Immutable</Badge>
                </div>
                <p className="text-xs text-[#8FA3B7]">
                  At stake funding (<code className="font-mono">createMatchWithStakes</code>), each <code className="font-mono">Match</code> row freezes <code className="font-mono">timeControlSeconds</code>, <code className="font-mono">rulesetVersion</code>, and <code className="font-mono">configurationVersion</code>.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card 1: Ruleset & Clock Configuration */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Clock className="w-5 h-5 text-[#18C986]" />
                    <div>
                      <CardTitle>Clocks, Readiness &amp; Reconnect Grace</CardTitle>
                      <CardDescription>
                        Authoritative server-side timing parameters for match lifecycle and move deadlines.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="default">Future Matches Only</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <Input
                    label="Per-Turn Time Control Seconds (`game.timeControlSeconds`)"
                    type="number"
                    min={15}
                    max={300}
                    disabled={!canEdit}
                    value={String(draftPayload.game.timeControlSeconds)}
                    onChange={(e) => setIntField('timeControlSeconds', e.target.value)}
                    error={fieldErrors['game.timeControlSeconds']}
                    helperText={`Current Active: ${activePayload.game.timeControlSeconds}s • Constraint: 15s – 300s (Snapshotted onto Match.timeControlSeconds at funding)`}
                  />

                  <Input
                    label="Match Readiness Timeout Seconds (`game.matchReadinessSeconds`)"
                    type="number"
                    min={10}
                    max={120}
                    disabled={!canEdit}
                    value={String(draftPayload.game.matchReadinessSeconds)}
                    onChange={(e) => setIntField('matchReadinessSeconds', e.target.value)}
                    error={fieldErrors['game.matchReadinessSeconds']}
                    helperText={`Current Active: ${activePayload.game.matchReadinessSeconds}s • Constraint: 10s – 120s before unconfirmed FUNDED match releases stakes`}
                  />

                  <Input
                    label="Disconnect Grace Period Milliseconds (`game.disconnectGraceMs`)"
                    type="number"
                    min={10000}
                    max={180000}
                    step={1000}
                    disabled={!canEdit}
                    value={String(draftPayload.game.disconnectGraceMs)}
                    onChange={(e) => setIntField('disconnectGraceMs', e.target.value)}
                    error={fieldErrors['game.disconnectGraceMs']}
                    helperText={`Current Active: ${activePayload.game.disconnectGraceMs} ms (${
                      activePayload.game.disconnectGraceMs / 1000
                    }s) • Constraint: 10,000 ms – 180,000 ms (10s – 180s)`}
                  />
                </div>
              </Card>

              {/* Card 2: Ruleset Version & Draw Rules */}
              <Card className="space-y-5">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Scale className="w-5 h-5 text-[#18C986]" />
                    <div>
                      <CardTitle>Ruleset Version &amp; Draw Adjudication Rules</CardTitle>
                      <CardDescription>
                        International Draughts engine version and automatic/mutual draw thresholds.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="gold">Engine Authority</Badge>
                </CardHeader>

                <div className="space-y-4">
                  <Input
                    label="International Draughts Ruleset Version (`game.rulesetVersion`)"
                    type="number"
                    min={1}
                    disabled={!canEdit}
                    value={String(draftPayload.game.rulesetVersion)}
                    onChange={(e) => setIntField('rulesetVersion', e.target.value)}
                    error={fieldErrors['game.rulesetVersion']}
                    helperText={`Current Active: v${activePayload.game.rulesetVersion} • Snapshotted onto Match.rulesetVersion at funding`}
                  />

                  <Input
                    label="Max Consecutive King Moves Before Auto-Draw (`game.maxConsecutiveKingMoves`)"
                    type="number"
                    min={20}
                    max={100}
                    disabled={!canEdit}
                    value={String(draftPayload.game.maxConsecutiveKingMoves)}
                    onChange={(e) => setIntField('maxConsecutiveKingMoves', e.target.value)}
                    error={fieldErrors['game.maxConsecutiveKingMoves']}
                    helperText={`Current Active: ${activePayload.game.maxConsecutiveKingMoves} moves • Constraint: 20 – 100 consecutive king moves without capture/promotion`}
                  />

                  <Input
                    label="Minimum Ply Count Before Mutual Draw Offer (`game.canOfferDrawPlyCount`)"
                    type="number"
                    min={40}
                    max={200}
                    disabled={!canEdit}
                    value={String(draftPayload.game.canOfferDrawPlyCount)}
                    onChange={(e) => setIntField('canOfferDrawPlyCount', e.target.value)}
                    error={fieldErrors['game.canOfferDrawPlyCount']}
                    helperText={`Current Active: ${activePayload.game.canOfferDrawPlyCount} plies (${
                      Math.floor(activePayload.game.canOfferDrawPlyCount / 2)
                    } full moves per player) • Constraint: 40 – 200 plies`}
                  />
                </div>
              </Card>
            </div>

            {/* Match Snapshot Isolation Reference Card */}
            <Card className="space-y-4">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                  <div>
                    <CardTitle>Match Snapshot Isolation &amp; Server Rule Authority</CardTitle>
                    <CardDescription>
                      How Draught Bet guarantees active matches are never mutated mid-game by configuration updates.
                    </CardDescription>
                  </div>
                </div>
                <Link href="/game-operations/matches">
                  <Button variant="outline" size="sm">
                    <Swords className="w-3.5 h-3.5" />
                    Inspect Live Matches
                  </Button>
                </Link>
              </CardHeader>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="bg-[#000000] border border-[#274056] rounded-lg p-4 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <Gamepad2 className="w-4 h-4 text-[#18C986]" />
                    <span>Pure Server-Side Engine Validation (`src/modules/engine/`)</span>
                  </div>
                  <p className="text-[#8FA3B7]">
                    Every <code className="font-mono">move.submit</code> / <code className="font-mono">move_attempt</code> socket payload is validated on the backend against the Redis CAS board state and durable <code className="font-mono">MatchMove</code> log. Client-side legal-move highlighting is strictly advisory.
                  </p>
                </div>

                <div className="bg-[#000000] border border-[#274056] rounded-lg p-4 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-[#F5F7FA]">
                    <Lock className="w-4 h-4 text-emerald-400" />
                    <span>Frozen Funding-Time Snapshot (`src/services/matchService.js`)</span>
                  </div>
                  <p className="text-[#8FA3B7]">
                    When stakes are locked into <code className="font-mono">PLAYER_LOCKED</code>, the match permanently records <code className="font-mono">settlementCommissionPercent</code>, <code className="font-mono">timeControlSeconds</code>, <code className="font-mono">configurationVersion</code>, and <code className="font-mono">rulesetVersion</code>.
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
