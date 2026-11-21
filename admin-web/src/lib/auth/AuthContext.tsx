'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { authApi } from '../api/auth';
import { apiClient, ApiError, purgeLegacyTokenStorage } from '../api/client';
import { type AdminUser } from '../permissions/guards';

// Stay signed in continuously during active operator work; sign out cleanly
// only after 30 minutes of leaving the tab idle. Kept in memory (ref) — zero
// auth tokens or sensitive state are persisted in localStorage/sessionStorage.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const PROACTIVE_REFRESH_WINDOW_MS = 4 * 60 * 1000;

interface AuthContextValue {
  user: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (identifier: string, password: string) => Promise<AdminUser>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<AdminUser | null>;
  verifyMfaSession: (code: string) => Promise<AdminUser | null>;
  recoverMfaSession: (recoveryCode: string) => Promise<AdminUser | null>;
  completeMfaEnrollment: (code: string) => Promise<AdminUser | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const lastActivityRef = useRef<number>(0);
  const router = useRouter();
  const pathname = usePathname();

  const touchActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const refreshProfile = useCallback(async (): Promise<AdminUser | null> => {
    try {
      const data = await authApi.getAdminMe();
      const adminUser: AdminUser = {
        id: data.id,
        email: data.email,
        username: data.username,
        fullName: data.fullName,
        roles: data.roles,
        permissions: data.permissions,
        mfa: data.mfa
      };
      setUser(adminUser);
      return adminUser;
    } catch (err) {
      if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403)) {
        apiClient.clearAuth();
        setUser(null);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    purgeLegacyTokenStorage();
    const handleAuthExpired = () => {
      apiClient.clearAuth();
      setUser(null);
      router.push('/login?expired=true');
    };

    window.addEventListener('draughtbet:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('draughtbet:auth-expired', handleAuthExpired);
  }, [router]);

  // Bootstrap session directly from server-verified HttpOnly cookies (no localStorage)
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const profile = await refreshProfile();
        if (active && profile) {
          lastActivityRef.current = Date.now();
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void init();
    return () => {
      active = false;
    };
  }, [refreshProfile]);

  // Activity listener + idle expiration & proactive HttpOnly cookie refresh loop
  useEffect(() => {
    if (!user) return undefined;
    if (lastActivityRef.current === 0) {
      lastActivityRef.current = Date.now();
    }

    const handleUserActivity = () => {
      const now = Date.now();
      if (now - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
        void authApi.logout().finally(() => {
          setUser(null);
          router.push('/login?expired=true');
        });
        return;
      }
      touchActivity();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
          void authApi.logout().finally(() => {
            setUser(null);
            router.push('/login?expired=true');
          });
        } else {
          touchActivity();
          void apiClient.ensureFreshToken(PROACTIVE_REFRESH_WINDOW_MS);
        }
      }
    };

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'mousemove', 'scroll', 'focus'];
    for (const ev of events) {
      window.addEventListener(ev, handleUserActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', handleVisibility);

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
        void authApi.logout().finally(() => {
          setUser(null);
          router.push('/login?expired=true');
        });
        return;
      }
      if (document.visibilityState === 'visible') {
        void apiClient.ensureFreshToken(PROACTIVE_REFRESH_WINDOW_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, handleUserActivity);
      }
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(interval);
    };
  }, [user, router, touchActivity]);

  const login = async (identifier: string, password: string): Promise<AdminUser> => {
    setIsLoading(true);
    try {
      await authApi.login(identifier, password);
      lastActivityRef.current = Date.now();
      const adminProfile = await refreshProfile();
      if (!adminProfile) {
        await authApi.logout();
        throw new Error('Access denied: account does not have admin privileges.');
      }
      return adminProfile;
    } finally {
      setIsLoading(false);
    }
  };

  const verifyMfaSession = async (code: string): Promise<AdminUser | null> => {
    await authApi.verifyMfaSession(code);
    lastActivityRef.current = Date.now();
    return refreshProfile();
  };

  const recoverMfaSession = async (recoveryCode: string): Promise<AdminUser | null> => {
    await authApi.recoverMfaSession(recoveryCode);
    lastActivityRef.current = Date.now();
    return refreshProfile();
  };

  const completeMfaEnrollment = async (code: string): Promise<AdminUser | null> => {
    await authApi.enableMfa(code);
    lastActivityRef.current = Date.now();
    return refreshProfile();
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await authApi.logout();
      setUser(null);
      router.push('/login');
    } finally {
      setIsLoading(false);
    }
  };

  // Protect (admin) routes from unauthenticated access
  useEffect(() => {
    if (!isLoading) {
      const isAuthRoute = pathname.startsWith('/login');
      if (!user && !isAuthRoute) {
        router.push('/login');
      } else if (user && isAuthRoute) {
        const needsMfa = Boolean(user.mfa?.enforced && !user.mfa?.verified);
        if (!needsMfa) {
          router.push('/dashboard');
        }
      }
    }
  }, [user, isLoading, pathname, router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        refreshProfile,
        verifyMfaSession,
        recoverMfaSession,
        completeMfaEnrollment
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext) ?? null;
}
