'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutGrid,
  Globe,
  Gamepad2,
  Coins,
  ShieldCheck,
  HeartHandshake,
  UsersRound,
  Flag,
  Bell,
  Wrench,
  History,
  CheckSquare
} from 'lucide-react';

export interface ConfigNavTab {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  restricted?: boolean;
  exact?: boolean;
}

export const CONFIG_NAV_TABS: ConfigNavTab[] = [
  { label: 'Overview', href: '/configuration', icon: LayoutGrid, exact: true },
  { label: 'Platform Settings', href: '/configuration/platform', icon: Globe },
  { label: 'Game Configuration', href: '/configuration/game', icon: Gamepad2 },
  { label: 'Financial Configuration', href: '/configuration/financial', icon: Coins, restricted: true },
  { label: 'KYC & Eligibility', href: '/configuration/kyc', icon: ShieldCheck, restricted: true },
  { label: 'Safer Play', href: '/configuration/safer-play', icon: HeartHandshake, restricted: true },
  { label: 'Matchmaking', href: '/configuration/matchmaking', icon: UsersRound },
  { label: 'Feature Flags', href: '/configuration/feature-flags', icon: Flag },
  { label: 'Notification Templates', href: '/configuration/notifications', icon: Bell },
  { label: 'Maintenance', href: '/configuration/maintenance', icon: Wrench },
  { label: 'Version History', href: '/configuration/versions', icon: History },
  { label: 'Approvals', href: '/configuration/approvals', icon: CheckSquare }
];

export function ConfigSubNav() {
  const pathname = usePathname();

  return (
    <div className="bg-[#15181D] border border-[#2E333B] rounded-xl p-2 overflow-x-auto scrollbar-thin scrollbar-thumb-[#2E333B]">
      <nav aria-label="Configuration sections" className="flex items-center gap-1 min-w-max">
        {CONFIG_NAV_TABS.map((tab) => {
          const isActive = tab.exact
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          const Icon = tab.icon;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-150 whitespace-nowrap',
                isActive
                  ? 'bg-[#3A2E17] text-[#E7B24A] border border-[#E7B24A]/40 font-semibold'
                  : 'text-[#9CA3AF] hover:text-[#F4F2ED] hover:bg-[#1E2229] border border-transparent'
              )}
            >
              <Icon className={cn('w-3.5 h-3.5 shrink-0', isActive ? 'text-[#E7B24A]' : 'text-[#6B7280]')} />
              <span>{tab.label}</span>
              {tab.restricted && (
                <span
                  title="Maker-Checker dual control required for changes in this domain"
                  className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
