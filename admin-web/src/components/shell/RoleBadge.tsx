import React from 'react';
import { AdminRole, ROLE_COLORS } from '@/lib/permissions/roles';
import { cn } from '@/lib/utils';

export function RoleBadge({ role, className }: { role: AdminRole; className?: string }) {
  const color = ROLE_COLORS[role] || {
    bg: 'bg-slate-500/10',
    text: 'text-slate-400',
    border: 'border-slate-500/30'
  };

  return (
    <span
      className={cn(
        'inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border tracking-wider uppercase',
        color.bg,
        color.text,
        color.border,
        className
      )}
    >
      {role.replace('_', ' ')}
    </span>
  );
}

