'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ShieldAlert, ArrowLeft } from 'lucide-react';

export default function AccessDeniedPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <Card className="max-w-md w-full p-8 space-y-5 bg-[#0C1B2A] border-[#274056]">
        <div className="inline-flex w-14 h-14 rounded-full bg-rose-500/10 border border-rose-500/30 items-center justify-center text-rose-400 mx-auto">
          <ShieldAlert className="w-8 h-8" />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-bold text-[#F5F7FA]">403 — Access Restricted</h2>
          <p className="text-xs text-[#8FA3B7] leading-relaxed">
            Your assigned role does not grant permission to view or execute actions on this resource. Every unauthorized attempt is recorded in the immutable audit log.
          </p>
        </div>

        <div className="p-3 bg-[#132638] border border-[#274056] rounded-lg text-left text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-[#53677A]">Account:</span>
            <span className="font-mono text-[#F5F7FA]">{user?.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#53677A]">Roles:</span>
            <span className="text-[#18C986] font-semibold">
              {user?.roles?.join(', ') || 'None'}
            </span>
          </div>
        </div>

        <Link href="/dashboard" className="block w-full">
          <Button variant="secondary" className="w-full gap-2">
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Operations Dashboard</span>
          </Button>
        </Link>
      </Card>
    </div>
  );
}

