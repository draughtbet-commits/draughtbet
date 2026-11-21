'use client';

import React, { useEffect, useState } from 'react';
import { adminApi } from '@/lib/api/admin';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { PERMISSIONS } from '@/lib/permissions/matrix';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RoleBadge } from '@/components/shell/RoleBadge';
import { AdminRole } from '@/lib/permissions/roles';

function TeamPageContent() {
  const [roles, setRoles] = useState<Array<{ name: string; description: string; permissions: string[]; assignedCount: number }>>([]);

  useEffect(() => {
    adminApi.getRoles()
      .then((res) => setRoles(res.roles))
      .catch(() => { });
  }, []);

  return (
    <div className="space-y-6">
      <div className="pb-2 border-b border-[#274056]">
        <h1 className="text-2xl font-bold tracking-tight text-[#F5F7FA]">
          Staff &amp; RBAC Administration
        </h1>
        <p className="text-xs text-[#8FA3B7] mt-0.5">
          Database-backed roles, permission matrices, and operator assignments.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {roles.map((r) => (
          <Card key={r.name} className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <RoleBadge role={r.name as AdminRole} />
                <Badge variant="default">{r.assignedCount} operators</Badge>
              </div>
              <p className="text-xs text-[#8FA3B7] leading-relaxed mt-2">
                {r.description}
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-[#274056]">
              <span className="text-[10px] uppercase font-bold text-[#53677A] block mb-1.5">
                Granted Permissions ({r.permissions.length})
              </span>
              <div className="flex flex-wrap gap-1">
                {r.permissions.map((p) => (
                  <span
                    key={p}
                    className="text-[10px] font-mono px-1.5 py-0.5 bg-[#132638] text-[#F5F7FA] rounded border border-[#274056]"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function TeamPage() {
  return (
    <RouteGuard permission={PERMISSIONS.ROLES_ADMIN} section="Staff & RBAC Administration">
      <TeamPageContent />
    </RouteGuard>
  );
}
