'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';

const SEGMENT_LABELS: Record<string, string> = {
  configuration: 'Configuration',
  platform: 'Platform Settings',
  game: 'Game Configuration',
  financial: 'Financial Configuration',
  kyc: 'KYC & Eligibility',
  'safer-play': 'Safer Play',
  matchmaking: 'Matchmaking',
  'feature-flags': 'Feature Flags',
  notifications: 'Notification Templates',
  maintenance: 'Maintenance Controls',
  versions: 'Version History',
  approvals: 'Approvals',
  'game-operations': 'Game Operations',
  compliance: 'Compliance',
  finance: 'Finance',
  withdrawals: 'Withdrawals',
  ledger: 'Ledger',
  disputes: 'Disputes',
  matches: 'Matches',
  players: 'Players',
  support: 'Support',
  system: 'System',
  audit: 'Audit Trail',
  health: 'System Health',
  team: 'Staff & Roles'
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-[#9CA3AF]">
      <Link
        href="/dashboard"
        className="flex items-center gap-1 hover:text-[#F4F2ED] transition-colors"
      >
        <Home className="w-3.5 h-3.5" />
        <span>Home</span>
      </Link>
      {segments.map((seg, idx) => {
        const href = `/${segments.slice(0, idx + 1).join('/')}`;
        const isLast = idx === segments.length - 1;
        const label =
          SEGMENT_LABELS[seg] ||
          seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');

        return (
          <React.Fragment key={href}>
            <ChevronRight className="w-3.5 h-3.5 text-[#6B7280]" />
            {isLast ? (
              <span className="text-[#F4F2ED] font-medium">{label}</span>
            ) : (
              <Link href={href} className="hover:text-[#F4F2ED] transition-colors">
                {label}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
