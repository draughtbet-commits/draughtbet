'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { authApi } from '../api/auth';
import { apiClient } from '../api/client';
import { AdminUser } from '../permissions/guards';

interface AuthContextValue {
  user: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (identifier: string, password: string) => Promise<AdminUser>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<AdminUser | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

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
    } catch {
      apiClient.clearAuth();
      setUser(null);
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
    const init = async () => {
      const token = apiClient.getAccessToken();

      if (token) {
        await refreshProfile();
      }
      setIsLoading(false);
    };

    init();
  }, [refreshProfile]);

  const login = async (identifier: string, password: string): Promise<AdminUser> => {
    setIsLoading(true);
    try {
      await authApi.login(identifier, password);
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

