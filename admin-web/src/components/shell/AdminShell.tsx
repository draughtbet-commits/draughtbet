'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { AdminSidebar } from './AdminSidebar';
import { AdminTopbar } from './AdminTopbar';
import { canAccessAdminRoute, getAdminRouteRule } from '@/lib/permissions/routes';
import { requiresMfaVerification } from '@/lib/permissions/guards';
import { AccessRestrictedPanel } from '@/components/auth/RouteGuard';
import { MfaChallengeScreen } from '@/components/auth/MfaChallengeScreen';

/**
 * Root shell for all `(admin)` routes.
 *
 * Security invariants:
 * 1. Never mounts `{children}`, `<AdminSidebar />`, or `<AdminTopbar />` until
 *    server-backed authentication finishes and succeeds (eliminating unauthenticated
 *    DOM mounting and premature child data-fetching effects).
 * 2. Enforces Admin MFA challenge/enrollment gate whenever MFA is required.
 * 3. Enforces route-level RBAC authorization BEFORE rendering `{children}` so
 *    unauthorized roles receive a clean 403 panel instead of mounting restricted pages.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isAuthenticated } = useAuth();
  const pathname = usePathname();

  if (isLoading || !isAuthenticated || !user) {
    return (
      <div className="min-h-screen bg-[#000000] flex flex-col items-center justify-center space-y-3">
        <div className="w-10 h-10 rounded-full border-2 border-[#18C986] border-t-transparent animate-spin" />
        <p className="text-xs font-medium text-[#8FA3B7] tracking-wider uppercase">
          {isLoading ? 'Verifying Operator Credentials...' : 'Redirecting to Sign In...'}
        </p>
      </div>
    );
  }

  if (requiresMfaVerification(user)) {
    return <MfaChallengeScreen />;
  }

  const routeAllowed = canAccessAdminRoute(user, pathname);
  const routeRule = getAdminRouteRule(pathname);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#000000] text-[#F5F7FA]">
      <AdminSidebar />
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <AdminTopbar />
        <main className="flex-1 overflow-y-auto p-6 bg-[#000000]">
          <div className="max-w-[1600px] mx-auto">
            {routeAllowed ? children : <AccessRestrictedPanel section={routeRule.section} />}
          </div>
        </main>
      </div>
    </div>
  );
}
