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
  Crown,
  GitBranch,
  CheckCircle2,
  Flag,
  Bell,
  Wrench,
  FlaskConical
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  badge?: string;
  exact?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, exact: true }
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
      { label: 'Top-Ups & Ledger', href: '/finance/ledger', icon: Receipt, permission: PERMISSIONS.WITHDRAWALS_READ }
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
      { label: 'Configuration', href: '/configuration', icon: Sliders, permission: PERMISSIONS.FLAGS_READ, exact: true },
      { label: 'Approvals Queue', href: '/configuration/approvals', icon: CheckCircle2, permission: PERMISSIONS.CONFIG_READ },
      { label: 'Version History', href: '/configuration/versions', icon: GitBranch, permission: PERMISSIONS.CONFIG_READ },
      { label: 'Feature Flags', href: '/configuration/feature-flags', icon: Flag, permission: PERMISSIONS.FLAGS_READ },
      { label: 'Notification Templates', href: '/configuration/notifications', icon: Bell, permission: PERMISSIONS.CONFIG_READ },
      { label: 'Maintenance Mode', href: '/configuration/maintenance', icon: Wrench, permission: PERMISSIONS.MAINTENANCE_READ }
    ]
  },
  {
    title: 'Administration',
    items: [
      { label: 'Staff & Roles', href: '/team', icon: UserCog, permission: PERMISSIONS.ROLES_ADMIN },
      { label: 'Audit Trail', href: '/system/audit', icon: FileText, permission: PERMISSIONS.AUDIT_READ },
      { label: 'Notifications', href: '/system/notifications', icon: Bell },
      { label: 'System Health', href: '/system/health', icon: Activity },
      { label: 'Simulation Lab', href: '/system/simulation', icon: FlaskConical, permission: PERMISSIONS.ROLES_ADMIN }
    ]
  }
];

const SUB_CONFIG_PATHS = [
  '/configuration/approvals',
  '/configuration/versions',
  '/configuration/feature-flags',
  '/configuration/notifications',
  '/configuration/maintenance'
];

export function AdminSidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <aside
      className={cn(
        'w-64 bg-[#000000] border-r border-[#274056] flex flex-col h-screen shrink-0',
        className
      )}
    >
      {/* Brand Header */}
      <div className="h-16 px-6 border-b border-[#274056] flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#0E2E2B] border border-[#18C986]/40 flex items-center justify-center text-[#18C986]">
            <Crown className="w-5 h-5" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-wider text-[#F5F7FA] uppercase">
              Draught Bet
            </span>
            <span className="block text-[10px] text-[#18C986] font-medium tracking-widest uppercase">
              Admin Ops
            </span>
          </div>
        </Link>
      </div>

      {/* Navigation Groups */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 scrollbar-thin scrollbar-thumb-[#274056]">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) => {
            if (!item.permission) return true;
            return canAccessPermission(user, item.permission);
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={section.title} className="space-y-1">
              <h4 className="px-3 text-[10px] font-bold uppercase tracking-wider text-[#53677A]">
                {section.title}
              </h4>
              <div className="space-y-0.5 mt-1">
                {visibleItems.map((item) => {
                  let isActive = false;
                  if (item.href === '/configuration') {
                    isActive =
                      pathname === '/configuration' ||
                      (pathname.startsWith('/configuration/') &&
                        !SUB_CONFIG_PATHS.some((p) => pathname.startsWith(p)));
                  } else if (item.exact) {
                    isActive = pathname === item.href;
                  } else {
                    isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  }

                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-150',
                        isActive
                          ? 'bg-[#132638] text-[#18C986] font-semibold border-l-2 border-[#18C986]'
                          : 'text-[#8FA3B7] hover:text-[#F5F7FA] hover:bg-[#0C1B2A]'
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon className={cn('w-4 h-4', isActive ? 'text-[#18C986]' : 'text-[#53677A]')} />
                        <span>{item.label}</span>
                      </div>
                      {item.badge && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#18C986]/20 text-[#18C986] font-bold">
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
      <div className="p-3 border-t border-[#274056] text-[11px] text-[#53677A] flex justify-between items-center">
        <span>Backend V2 Connected</span>
        <span className="font-mono text-[10px] bg-[#132638] px-1.5 py-0.5 rounded text-[#8FA3B7]">
          v1.0-RC
        </span>
      </div>
    </aside>
  );
}
