'use client';

import React from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { Permission } from '@/lib/permissions/matrix';
import { AdminRole } from '@/lib/permissions/roles';
import { canAccessPermission, hasAnyRole } from '@/lib/permissions/guards';

export interface PermissionGateProps {
  permission?: Permission;
  roles?: readonly AdminRole[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function PermissionGate({ permission, roles, fallback = null, children }: PermissionGateProps) {
  const { user } = useAuth();

  if (!user) return <>{fallback}</>;

  if (permission && !canAccessPermission(user, permission)) {
    return <>{fallback}</>;
  }

  if (roles && !hasAnyRole(user, roles)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

