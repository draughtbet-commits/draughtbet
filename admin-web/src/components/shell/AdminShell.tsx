'use client';

import React from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { AdminSidebar } from './AdminSidebar';
import { AdminTopbar } from './AdminTopbar';
import { Loader2 } from 'lucide-react';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0B0D10] flex flex-col items-center justify-center text-[#F4F2ED] gap-3">
        <Loader2 className="w-8 h-8 text-[#E7B24A] animate-spin" />
        <span className="text-xs uppercase tracking-widest text-[#9CA3AF]">
          Authorizing Session...
        </span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0B0D10] text-[#F4F2ED]">
      <AdminSidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <AdminTopbar />
        <main className="flex-1 overflow-y-auto p-6 bg-[#0B0D10] scrollbar-thin scrollbar-thumb-[#2E333B]">
          <div className="max-w-7xl mx-auto space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

