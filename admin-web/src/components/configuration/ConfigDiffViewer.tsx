'use client';

import React, { useState } from 'react';
import { ConfigDomainName, PlatformConfigPayload } from '@/lib/api/types';
import { computeConfigDiff, DiffStatus } from '@/lib/config/diff';
import { Badge } from '@/components/ui/Badge';
import { ShieldAlert, ArrowRight, CheckCircle2 } from 'lucide-react';

export interface ConfigDiffViewerProps {
  basePayload: PlatformConfigPayload | null | undefined;
  targetPayload: PlatformConfigPayload | null | undefined;
  baseLabel?: string;
  targetLabel?: string;
  defaultShowUnchanged?: boolean;
  filterDomains?: ConfigDomainName[];
}

export function ConfigDiffViewer({
  basePayload,
  targetPayload,
  baseLabel = 'Baseline (Active)',
  targetLabel = 'Proposed / Target',
  defaultShowUnchanged = false,
  filterDomains
}: ConfigDiffViewerProps) {
  const [showUnchanged, setShowUnchanged] = useState(defaultShowUnchanged);
  const summary = computeConfigDiff(basePayload, targetPayload);

  const visibleGroups = summary.domains
    .filter((g) => (!filterDomains || filterDomains.length === 0 ? true : filterDomains.includes(g.domain)))
    .map((g) => ({
      ...g,
      visibleFields: showUnchanged ? g.fields : g.fields.filter((f) => f.status !== 'UNCHANGED')
    }))
    .filter((g) => g.visibleFields.length > 0);

  const getStatusBadge = (status: DiffStatus) => {
    switch (status) {
      case 'CHANGED':
        return <Badge variant="warning">Modified</Badge>;
      case 'ADDED':
        return <Badge variant="success">Added</Badge>;
      case 'REMOVED':
        return <Badge variant="danger">Removed</Badge>;
      default:
        return <Badge variant="default">Unchanged</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Diff Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#132638] border border-[#274056] rounded-xl p-3.5">
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <span className="font-semibold text-[#F5F7FA]">Comparison Summary:</span>
          <Badge variant={summary.totalChanged > 0 ? 'warning' : 'default'}>
            {summary.totalChanged} Changed
          </Badge>
          {summary.totalAdded > 0 && <Badge variant="success">{summary.totalAdded} Added</Badge>}
          {summary.totalRemoved > 0 && <Badge variant="danger">{summary.totalRemoved} Removed</Badge>}
          <Badge variant="default">{summary.totalUnchanged} Unchanged</Badge>
          {summary.isRestricted && (
            <Badge variant="gold">
              <ShieldAlert className="w-3 h-3" />
              Maker-Checker Required ({summary.modifiedDomains.join(', ')})
            </Badge>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-[#8FA3B7] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showUnchanged}
            onChange={(e) => setShowUnchanged(e.target.checked)}
            className="rounded border-[#274056] bg-[#0C1B2A] text-[#18C986] focus:ring-[#18C986]"
          />
          <span>Show unchanged parameters ({summary.totalUnchanged})</span>
        </label>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-8 text-center">
          <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
          <p className="text-sm font-semibold text-[#F5F7FA]">No Configuration Differences Detected</p>
          <p className="text-xs text-[#8FA3B7] mt-1">
            All parameters in {targetLabel} match {baseLabel}. Toggle &ldquo;Show unchanged parameters&rdquo; above to inspect all fields.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleGroups.map((group) => (
            <div
              key={group.domain}
              className="bg-[#0C1B2A] border border-[#274056] rounded-xl overflow-hidden"
            >
              <div className="px-4 py-3 bg-[#132638] border-b border-[#274056] flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#F5F7FA]">
                      {group.metadata.label}
                    </span>
                    <Badge variant="default">{group.domain}</Badge>
                    {group.metadata.isRestricted && (
                      <Badge variant="gold">Restricted Domain (Maker-Checker)</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-[#8FA3B7] mt-0.5">{group.metadata.operationalImpact}</p>
                </div>
                <div className="text-xs text-[#8FA3B7]">
                  {group.changedCount} modified / {group.fields.length} total
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#274056] text-[10px] font-bold uppercase tracking-wider text-[#53677A] bg-[#000000]/40">
                      <th className="py-2.5 px-4">Parameter</th>
                      <th className="py-2.5 px-4">{baseLabel}</th>
                      <th className="py-2.5 px-2 w-6"></th>
                      <th className="py-2.5 px-4">{targetLabel}</th>
                      <th className="py-2.5 px-4 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#274056] text-xs">
                    {group.visibleFields.map((field) => {
                      const isChanged = field.status !== 'UNCHANGED';
                      return (
                        <tr
                          key={field.path}
                          className={isChanged ? 'bg-amber-500/5' : 'hover:bg-[#132638]/50'}
                        >
                          <td className="py-3 px-4 align-top">
                            <div className="font-semibold text-[#F5F7FA]">{field.label}</div>
                            <div className="font-mono text-[11px] text-[#53677A]">{field.path}</div>
                          </td>
                          <td className="py-3 px-4 align-top font-mono text-[#8FA3B7]">
                            {field.beforeFormatted}
                          </td>
                          <td className="py-3 px-2 align-top text-[#53677A]">
                            <ArrowRight className="w-3.5 h-3.5 mt-0.5" />
                          </td>
                          <td
                            className={`py-3 px-4 align-top font-mono ${
                              isChanged ? 'text-[#18C986] font-semibold' : 'text-[#F5F7FA]'
                            }`}
                          >
                            {field.afterFormatted}
                          </td>
                          <td className="py-3 px-4 align-top text-right">
                            {getStatusBadge(field.status)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
