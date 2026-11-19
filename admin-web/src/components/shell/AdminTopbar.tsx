'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { Breadcrumbs } from './Breadcrumbs';
import { RoleBadge } from './RoleBadge';
import { LogOut, User as UserIcon } from 'lucide-react';

export function AdminTopbar() {
  const { user, logout } = useAuth();

  return (
    <header className="h-16 bg-[#0C1B2A] border-b border-[#274056] px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <Breadcrumbs />
      </div>

      <div className="flex items-center gap-4">
        {/* User profile & role badge */}
        <div className="flex items-center gap-3">
          <Link
            href="/profile"
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
          >
            <div className="w-8 h-8 rounded-full bg-[#132638] border border-[#274056] flex items-center justify-center text-[#18C986]">
              <UserIcon className="w-4 h-4" />
            </div>
            <div className="text-left hidden sm:block">
              <span className="block text-xs font-semibold text-[#F5F7FA]">
                {user?.fullName || user?.username || user?.email || 'Admin'}
              </span>
              <div className="flex gap-1 mt-0.5">
                {user?.roles?.map((role) => (
                  <RoleBadge key={role} role={role} />
                ))}
              </div>
            </div>
          </Link>

          {/* Logout Action */}
          <button
            onClick={() => logout()}
            className="p-2 text-[#8FA3B7] hover:text-[#F55A67] hover:bg-[#132638] rounded-lg transition-colors"
            title="Sign out of Admin Console"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

