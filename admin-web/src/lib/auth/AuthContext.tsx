'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { authApi } from '../api/auth';
import { apiClient, ApiError } from '../api/client';
import { AdminUser } from '../permissions/guards';

const LAST_ACTIVITY_KEY = 'draughtbet_admin_last_activity';
// Stay signed in continuously during active operator work; sign out cleanly
// only after 30 minutes of leaving the tab idle.
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
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readLastActivity(): number {
  if (typeof window === 'undefined') return Date.now();
  const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function writeLastActivity(ts = Date.now()) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LAST_ACTIVITY_KEY, String(ts));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const lastWriteRef = useRef(0);
  const router = useRouter();
  const pathname = usePathname();

  const touchActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastWriteRef.current >= 5000) {
      lastWriteRef.current = now;
      writeLastActivity(now);
    }
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
        permissions: data.permissions
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
    const handleAuthExpired = () => {
      setUser(null);
      router.push('/login?expired=true');
    };

    window.addEventListener('draughtbet:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('draughtbet:auth-expired', handleAuthExpired);
  }, [router]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      const token = apiClient.getAccessToken();
      if (token) {
        const lastActive = readLastActivity();
        if (Date.now() - lastActive >= IDLE_TIMEOUT_MS) {
          await authApi.logout();
          if (active) setUser(null);
        } else {
          writeLastActivity(Date.now());
          await refreshProfile();
        }
      }
      if (active) setIsLoading(false);
    };

    void init();
    return () => {
      active = false;
    };
  }, [refreshProfile]);

  // Activity listener + idle expiration & proactive token refresh loop
  useEffect(() => {
    if (!user) return undefined;

    const handleUserActivity = () => {
      const now = Date.now();
      const idleElapsed = now - readLastActivity();
      if (idleElapsed >= IDLE_TIMEOUT_MS) {
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
        const idleElapsed = Date.now() - readLastActivity();
        if (idleElapsed >= IDLE_TIMEOUT_MS) {
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
      const idleElapsed = Date.now() - readLastActivity();
      if (idleElapsed >= IDLE_TIMEOUT_MS) {
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
      writeLastActivity(Date.now());
      const adminProfile = await refreshProfile();
      if (!adminProfile) {
        throw new Error('Access denied: account does not have admin privileges.');
      }
      return adminProfile;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await authApi.logout();
      if (typeof window !== 'undefined') {
        localStorage.removeItem(LAST_ACTIVITY_KEY);
      }
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
        router.push('/dashboard');
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
        refreshProfile
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
