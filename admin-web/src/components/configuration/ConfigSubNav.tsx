'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOptionalAuth } from '@/lib/auth/AuthContext';
import type { AdminUser } from '@/lib/permissions/guards';
import { canAccessAdminRoute } from '@/lib/permissions/routes';
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

export interface ConfigSubNavProps {
  user?: AdminUser | null;
}

export function ConfigSubNav({ user: userOverride }: ConfigSubNavProps) {
  const pathname = usePathname();
  const auth = useOptionalAuth();
  const effectiveUser = userOverride !== undefined ? userOverride : (auth?.user ?? null);

  const visibleTabs = CONFIG_NAV_TABS.filter((tab) => canAccessAdminRoute(effectiveUser, tab.href));

  return (
    <div className="bg-[#0C1B2A] border border-[#274056] rounded-xl p-2 overflow-x-auto scrollbar-thin scrollbar-thumb-[#274056]">
      <nav aria-label="Configuration sections" className="flex items-center gap-1 min-w-max">
        {visibleTabs.map((tab) => {
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
                  ? 'bg-[#0E2E2B] text-[#18C986] border border-[#18C986]/40 font-semibold'
                  : 'text-[#8FA3B7] hover:text-[#F5F7FA] hover:bg-[#132638] border border-transparent'
              )}
            >
              <Icon className={cn('w-3.5 h-3.5 shrink-0', isActive ? 'text-[#18C986]' : 'text-[#53677A]')} />
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
