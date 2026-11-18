import React from 'react';
import { ConfigSubNav } from '@/components/configuration/ConfigSubNav';
import { Sliders } from 'lucide-react';

export default function ConfigurationLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      {/* Top Section Header */}
      <div className="pb-3 border-b border-[#2E333B] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#3A2E17] border border-[#E7B24A]/40 flex items-center justify-center text-[#E7B24A] shrink-0">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#F4F2ED]">
              Platform Configuration &amp; Governance
            </h1>
            <p className="text-xs text-[#9CA3AF] mt-0.5">
              Immutable versioned configuration, Maker-Checker dual control, feature flags, notification templates, and maintenance operations.
            </p>
          </div>
        </div>
      </div>

      {/* 12-Module Sub-Navigation */}
      <ConfigSubNav />

      {/* Active Module Page */}
      <div>{children}</div>
    </div>
  );
}
