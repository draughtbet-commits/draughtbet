import React from 'react';
import { AdminShell } from '@/components/shell/AdminShell';

export default function AdminGroupLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}

