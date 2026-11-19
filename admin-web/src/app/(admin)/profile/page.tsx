'use client';

import React from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { RoleBadge } from '@/components/shell/RoleBadge';
import { ROLE_DESCRIPTIONS } from '@/lib/permissions/roles';
import { ShieldCheck, User } from 'lucide-react';

export default function ProfilePage() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[#F5F7FA]">
          Admin Profile & Security
        </h1>
        <p className="text-xs text-[#8FA3B7] mt-1">
          Review operator identity, assigned roles, and effective permissions matrix.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Identity & Roles */}
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <User className="w-4 h-4 text-[#18C986]" />
                Operator Identity
              </CardTitle>
            </CardHeader>
            <div className="space-y-3 text-xs">
              <div>
                <span className="text-[#53677A] block">Operator ID:</span>
                <span className="font-mono text-[#F5F7FA] text-[11px] select-all">
                  {user?.id}
                </span>
              </div>
              <div>
                <span className="text-[#53677A] block">Email:</span>
                <span className="font-semibold text-[#F5F7FA]">{user?.email}</span>
              </div>
              <div>
                <span className="text-[#53677A] block">Username:</span>
                <span className="text-[#F5F7FA]">{user?.username || '—'}</span>
              </div>
              <div>
                <span className="text-[#53677A] block">Full Name:</span>
                <span className="text-[#F5F7FA]">{user?.fullName || '—'}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Assigned Roles</CardTitle>
              <CardDescription>Roles control access to backend domains</CardDescription>
            </CardHeader>
            <div className="space-y-3">
              {user?.roles?.map((role) => (
                <div key={role} className="p-3 bg-[#132638] border border-[#274056] rounded-lg space-y-1">
                  <div className="flex items-center justify-between">
                    <RoleBadge role={role} />
                  </div>
                  <p className="text-[11px] text-[#8FA3B7] mt-1">
                    {ROLE_DESCRIPTIONS[role]}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right Column: Security & Permissions */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="w-4 h-4 text-[#18C986]" />
                Authentication & Security
              </CardTitle>
              <CardDescription>
                Session status and credential-based access controls
              </CardDescription>
            </CardHeader>
            <div className="space-y-3 text-xs text-[#8FA3B7]">
              <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-semibold text-[#F5F7FA] block">Session Management</span>
                  <span className="text-[11px]">Rotated Bearer tokens with active server-side revocation</span>
                </div>
                <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Active
                </span>
              </div>
              <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-semibold text-[#F5F7FA] block">Role-Based Access Control</span>
                  <span className="text-[11px]">Server-enforced authorization policies for 6 distinct roles</span>
                </div>
                <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Enforced
                </span>
              </div>
            </div>
          </Card>

          {/* Effective Permissions Matrix */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Effective Permissions</CardTitle>
              <CardDescription>
                Granted permissions based on active role assignments
              </CardDescription>
            </CardHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {user?.permissions?.map((perm) => (
                <div
                  key={perm}
                  className="p-2.5 bg-[#132638] border border-[#274056] rounded flex items-center justify-between"
                >
                  <span className="font-mono text-[#F5F7FA]">{perm}</span>
                  <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">
                    Granted
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

