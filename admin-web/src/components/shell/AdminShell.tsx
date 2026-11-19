'use client';

import React, { Suspense } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { AdminSidebar } from './AdminSidebar';
import { AdminTopbar } from './AdminTopbar';
import { Loader2 } from 'lucide-react';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const showAuthGate = isLoading || !isAuthenticated;

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#000000] text-[#F5F7FA]">
      {showAuthGate && (
        <div className="fixed inset-0 z-50 bg-[#000000] flex flex-col items-center justify-center text-[#F5F7FA] gap-3">
          <Loader2 className="w-8 h-8 text-[#18C986] animate-spin" />
          <span className="text-xs uppercase tracking-widest text-[#8FA3B7]">
            {isLoading ? 'Authorizing Session...' : 'Redirecting to Sign In...'}
          </span>
        </div>
      )}
      <AdminSidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <AdminTopbar />
        <main className="flex-1 overflow-y-auto p-6 bg-[#000000] scrollbar-thin scrollbar-thumb-[#274056]">
          <div className="max-w-7xl mx-auto space-y-6">
            <Suspense
              fallback={
                <div className="py-16 flex items-center justify-center text-xs text-[#8FA3B7]">
                  Loading view...
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

