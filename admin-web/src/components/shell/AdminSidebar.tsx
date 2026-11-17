'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { PERMISSIONS, Permission } from '@/lib/permissions/matrix';
import { canAccessPermission } from '@/lib/permissions/guards';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  Wallet,
  Receipt,
  ShieldCheck,
  AlertTriangle,
  Swords,
  Scale,
  LifeBuoy,
  Sliders,
  UserCog,
  FileText,
  Activity,
  Crown
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  badge?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }
    ]
  },
  {
    title: 'User Management',
    items: [
      { label: 'Players', href: '/players', icon: Users }
    ]
  },
  {
    title: 'Financial Operations',
    items: [
      { label: 'Withdrawal Queue', href: '/finance/withdrawals', icon: Wallet, permission: PERMISSIONS.WITHDRAWALS_READ },
      { label: 'Ledger Explorer', href: '/finance/ledger', icon: Receipt, permission: PERMISSIONS.LEDGER_ADJUST }
    ]
  },
  {
    title: 'Risk & Compliance',
    items: [
      { label: 'KYC Reviews', href: '/compliance/kyc', icon: ShieldCheck, permission: PERMISSIONS.VERIFICATION_REVIEW },
      { label: 'Risk & Safer Play', href: '/compliance/risk', icon: AlertTriangle, permission: PERMISSIONS.RISK_REVIEW }
    ]
  },
  {
    title: 'Game Operations',
    items: [
      { label: 'Match Monitor', href: '/game-operations/matches', icon: Swords },
      { label: 'Disputes Queue', href: '/game-operations/disputes', icon: Scale, permission: PERMISSIONS.DISPUTES_MANAGE }
    ]
  },
  {
    title: 'Support',
    items: [
      { label: 'Support Cases', href: '/support', icon: LifeBuoy, permission: PERMISSIONS.USERS_MANAGE }
    ]
  },
  {
    title: 'Platform Control',
    items: [
      { label: 'Configuration', href: '/configuration', icon: Sliders, permission: PERMISSIONS.ROLES_ADMIN }
    ]
  },
  {
    title: 'Administration',
    items: [
      { label: 'Staff & Roles', href: '/team', icon: UserCog, permission: PERMISSIONS.ROLES_ADMIN },
      { label: 'Audit Trail', href: '/system/audit', icon: FileText, permission: PERMISSIONS.AUDIT_READ },
      { label: 'System Health', href: '/system/health', icon: Activity }
    ]
  }
];

export function AdminSidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <aside
      className={cn(
        'w-64 bg-[#0B0D10] border-r border-[#2E333B] flex flex-col h-screen shrink-0',
        className
      )}
    >
      {/* Brand Header */}
      <div className="h-16 px-6 border-b border-[#2E333B] flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#3A2E17] border border-[#E7B24A]/40 flex items-center justify-center text-[#E7B24A]">
            <Crown className="w-5 h-5" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-wider text-[#F4F2ED] uppercase">
              Draught Bet
            </span>
            <span className="block text-[10px] text-[#E7B24A] font-medium tracking-widest uppercase">
              Admin Ops
            </span>
          </div>
        </Link>
      </div>

      {/* Navigation Groups */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 scrollbar-thin scrollbar-thumb-[#2E333B]">
        {NAV_SECTIONS.map((section) => {
          // Filter items based on user permissions
          const visibleItems = section.items.filter((item) => {
            if (!item.permission) return true;
            return canAccessPermission(user, item.permission);
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={section.title} className="space-y-1">
              <h4 className="px-3 text-[10px] font-bold uppercase tracking-wider text-[#6B7280]">
                {section.title}
              </h4>
              <div className="space-y-0.5 mt-1">
                {visibleItems.map((item) => {
                  const isActive =
                    pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-150',
                        isActive
                          ? 'bg-[#1E2229] text-[#E7B24A] font-semibold border-l-2 border-[#E7B24A]'
                          : 'text-[#9CA3AF] hover:text-[#F4F2ED] hover:bg-[#15181D]'
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon className={cn('w-4 h-4', isActive ? 'text-[#E7B24A]' : 'text-[#6B7280]')} />
                        <span>{item.label}</span>
                      </div>
                      {item.badge && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#E7B24A]/20 text-[#E7B24A] font-bold">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Version info */}
      <div className="p-3 border-t border-[#2E333B] text-[11px] text-[#6B7280] flex justify-between items-center">
        <span>Backend V2 Connected</span>
        <span className="font-mono text-[10px] bg-[#1E2229] px-1.5 py-0.5 rounded text-[#9CA3AF]">
          v1.0-RC
        </span>
      </div>
    </aside>
  );
}

